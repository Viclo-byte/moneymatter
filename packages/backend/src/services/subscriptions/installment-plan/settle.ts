import { SUBSCRIPTION_PERIOD_STATUSES, TRANSACTION_TRANSFER_NATURE, TRANSACTION_TYPES } from '@bt/shared/types';
import { Money } from '@common/types/money';
import { ConflictError } from '@js/errors';
import Plans from '@models/installment-plans.model';
import Items from '@models/installment-schedule-items.model';
import Settlements, { type SettlementSnapshot } from '@models/installment-settlements.model';
import Periods from '@models/subscription-periods.model';
import Subscriptions from '@models/subscriptions.model';
import { findTransactions } from '@models/transactions-query';
import { withTransaction } from '@services/common/with-transaction';
import { createTransaction } from '@services/transactions/create-transaction';
import { deleteTransaction } from '@services/transactions/delete-transaction';
import { Op } from 'sequelize';

import { buildTransactionFromSubscription } from '../build-transaction-from-subscription';
import { withoutPeriodSettlement } from '../period-settlement-context';
import { resolveOpenPeriodStatus } from '../resolve-period-status';
import { advancePlan, lockSubscription, planError, validatePlanAccounts } from './plans';
import { installmentPayoffSchema } from './schema';

interface PayParams {
  subscription: Subscriptions;
  plan: Plans;
  period: Periods;
  generation?: number;
  createTransaction?: boolean;
  transactionId?: string | null;
  amount?: number;
  accountId?: string | null;
  time?: Date;
  notes?: string | null;
  payoff?: { principal: number; interest: number };
}

/** Caller holds the subscription lock, and this whole operation shares its transaction. */
export async function payInstallmentPeriod(params: PayParams) {
  const { subscription, plan, period, generation, time = new Date(), payoff } = params;
  if (generation === undefined || generation !== period.settlementGeneration)
    throw new ConflictError({ message: 'Payment preview is stale. Reload the installment before paying.' });
  if (
    !params.createTransaction ||
    params.transactionId ||
    params.amount !== undefined ||
    (params.accountId != null && params.accountId !== plan.sourceAccountId)
  )
    return planError(
      'Pay an installment from its schedule; linking, mark-only and amount/account overrides are not allowed.',
    );
  const item = await Items.findOne({ where: { planId: plan.id, periodId: period.id }, lock: true });
  if (!item) return planError('The payment period has no installment schedule item.');
  const settled = await Settlements.findOne({ where: { periodId: period.id, generation, state: 'settled' } });
  if (settled) return period.reload();
  if (!subscription.isActive) return planError('Resume the installment before paying.');
  if (item.status !== 'pending' || !['upcoming', 'overdue'].includes(period.status))
    throw new ConflictError({ message: 'This installment is already settled or cancelled.' });
  const next = await Items.findOne({
    where: { planId: plan.id, status: 'pending' },
    order: [['occurrenceNumber', 'ASC']],
  });
  if (next?.id !== item.id) return planError('Pay the earliest pending installment first.');
  const accounts = await validatePlanAccounts(subscription, plan.configuration, true);
  const pending = await Items.findAll({
    where: { planId: plan.id, status: 'pending' },
    order: [['occurrenceNumber', 'ASC']],
    lock: true,
  });
  const remaining = Money.sum(pending.map((i) => i.principal));
  if (plan.configuration.linkedSettlementEnabled) {
    const destination = accounts.find((a) => a.id === plan.configuration.destinationAccountId)!;
    if (!destination.currentBalance.negate().equals(remaining))
      return planError('The liability balance no longer matches remaining principal. Reconcile it before paying.');
  }
  const principal = payoff ? Money.fromDecimal(payoff.principal) : item.principal;
  const interest = payoff ? Money.fromDecimal(payoff.interest) : item.interest;
  const total = principal.add(interest);
  if (
    !total.isPositive() ||
    principal.isNegative() ||
    interest.isNegative() ||
    !total.equals(payoff ? total : item.total)
  )
    return planError('Invalid installment amounts.');
  if (payoff && !principal.equals(remaining)) return planError('Early payoff must settle all remaining principal.');
  const snapshot: SettlementSnapshot = {
    principal: principal.toNumber(),
    interest: interest.toNumber(),
    total: total.toNumber(),
    sourceAccountId: plan.sourceAccountId,
    destinationAccountId: plan.configuration.destinationAccountId ?? null,
    currencyCode: plan.currencyCode,
    transferId: null,
    principalTransactionId: null,
    interestTransactionId: null,
    cancelledItemIds: [],
    ...(payoff
      ? {
          itemBeforePayoff: {
            principal: item.principal.toNumber(),
            interest: item.interest.toNumber(),
            total: item.total.toNumber(),
          },
        }
      : {}),
  };
  const transactionIds: string[] = [];
  await withoutPeriodSettlement({
    run: async () => {
      if (plan.configuration.linkedSettlementEnabled) {
        if (principal.isPositive()) {
          const pair = await createTransaction({
            userId: subscription.userId,
            accountId: plan.sourceAccountId,
            destinationAccountId: plan.configuration.destinationAccountId!,
            amount: principal,
            destinationAmount: principal,
            transactionType: TRANSACTION_TYPES.expense,
            transferNature: TRANSACTION_TRANSFER_NATURE.common_transfer,
            time,
            note: subscription.name,
          });
          const out = pair.find((t) => t?.accountId === plan.sourceAccountId);
          const incoming = pair.find((t) => t?.accountId === plan.configuration.destinationAccountId);
          if (
            pair.length !== 2 ||
            !out ||
            !incoming ||
            !out.transferId ||
            out.transferId !== incoming.transferId ||
            out.transactionType !== TRANSACTION_TYPES.expense ||
            incoming.transactionType !== TRANSACTION_TYPES.income ||
            !out.amount.equals(principal) ||
            !incoming.amount.equals(principal) ||
            pair.some((t) => !t || t.transferNature !== TRANSACTION_TRANSFER_NATURE.common_transfer)
          )
            return planError('The installment principal transfer is inconsistent.');
          snapshot.transferId = out.transferId;
          snapshot.principalTransactionId = out.id;
          transactionIds.push(...pair.map((t) => t!.id));
        }
        if (interest.isPositive()) {
          const [tx] = await createTransaction({
            userId: subscription.userId,
            accountId: plan.sourceAccountId,
            amount: interest,
            transactionType: TRANSACTION_TYPES.expense,
            transferNature: TRANSACTION_TRANSFER_NATURE.not_transfer,
            categoryId: plan.configuration.interestCategoryId!,
            categoryIdIsExplicit: true,
            time,
            note: subscription.name,
          });
          if (
            !tx ||
            !tx.amount.equals(interest) ||
            tx.categoryId !== plan.configuration.interestCategoryId ||
            tx.excludeFromStats ||
            tx.transferNature !== TRANSACTION_TRANSFER_NATURE.not_transfer
          )
            return planError('The interest transaction is inconsistent.');
          snapshot.interestTransactionId = tx.id;
          transactionIds.push(tx.id);
        }
      } else {
        const build = await buildTransactionFromSubscription({ subscription, amount: total.toNumber(), time });
        const [tx] = await createTransaction(build);
        if (!tx) return planError('Installment payment could not be created.');
        snapshot.interestTransactionId = tx.id;
        transactionIds.push(tx.id);
      }
    },
  });
  if (payoff) {
    snapshot.cancelledItemIds = pending.filter((i) => i.id !== item.id).map((i) => i.id);
    await Items.update({ status: 'cancelled' }, { where: { id: { [Op.in]: snapshot.cancelledItemIds } } });
    await item.update({ principal, interest, total });
  }
  await Settlements.create({
    planId: plan.id,
    itemId: item.id,
    periodId: period.id,
    generation,
    state: 'settled',
    transactionIds,
    snapshot,
  });
  await item.update({ status: 'paid' });
  await period.update({
    status: SUBSCRIPTION_PERIOD_STATUSES.paid,
    paidAt: time,
    transactionId: snapshot.principalTransactionId ?? snapshot.interestTransactionId,
    transactionAutoCreated: true,
    notes: params.notes ?? period.notes,
  });
  await plan.update({ revision: plan.revision + 1 });
  await advancePlan(subscription, plan);
  return period.reload();
}

export async function revertInstallmentPeriod(
  subscription: Subscriptions,
  plan: Plans,
  period: Periods,
  assertCanDelete?: () => void,
) {
  const settlement = await Settlements.findOne({
    where: { planId: plan.id, periodId: period.id, state: 'settled' },
    lock: true,
  });
  if (!settlement) return planError('No active installment settlement exists for this period.');
  const item = await Items.findByPk(settlement.itemId, { lock: true });
  if (!item) return planError('Installment schedule item not found.');
  if (
    await Items.count({
      where: { planId: plan.id, status: 'paid', occurrenceNumber: { [Op.gt]: item.occurrenceNumber } },
    })
  )
    return planError('Revert later installments first to preserve the principal schedule.');
  assertCanDelete?.();
  const rows = await findTransactions({
    access: { creator: subscription.userId },
    planned: 'exclude',
    balanceAdjustments: 'exclude',
    completeness: 'all',
    where: { id: { [Op.in]: settlement.transactionIds } },
    lock: true,
  });
  if (rows.length !== settlement.transactionIds.length)
    return planError('A settlement transaction is missing. Reconcile it before reverting.');
  // All rows were immutable since creation. Marking reverting releases the DB guard
  // only in this transaction; an error rolls that release and every deletion back.
  await settlement.update({ state: 'reverting' });
  const { snapshot } = settlement;
  if (snapshot.principalTransactionId)
    await deleteTransaction({ id: snapshot.principalTransactionId, userId: subscription.userId, permanent: true });
  if (snapshot.interestTransactionId)
    await deleteTransaction({ id: snapshot.interestTransactionId, userId: subscription.userId, permanent: true });
  const open = await Periods.findAll({
    where: { subscriptionId: subscription.id, status: ['upcoming', 'overdue'] },
    lock: true,
  });
  for (const next of open) if (next.id !== period.id) await next.destroy();
  if (snapshot.cancelledItemIds.length)
    await Items.update({ status: 'pending' }, { where: { id: { [Op.in]: snapshot.cancelledItemIds } } });
  await item.update({
    status: 'pending',
    generation: item.generation + 1,
    ...(snapshot.itemBeforePayoff
      ? {
          principal: Money.fromDecimal(snapshot.itemBeforePayoff.principal),
          interest: Money.fromDecimal(snapshot.itemBeforePayoff.interest),
          total: Money.fromDecimal(snapshot.itemBeforePayoff.total),
        }
      : {}),
  });
  await period.update({
    status: resolveOpenPeriodStatus({ dueDate: period.dueDate }),
    paidAt: null,
    transactionId: null,
    transactionAutoCreated: false,
    settlementGeneration: period.settlementGeneration + 1,
  });
  await settlement.update({ state: 'reverted' });
  await plan.update({ revision: plan.revision + 1 });
  await subscription.update({ isActive: true, completedAt: null });
  await advancePlan(subscription, plan);
  return period.reload();
}

export const payoffInstallment = withTransaction(
  async ({ userId, subscriptionId, input }: { userId: number; subscriptionId: string; input: unknown }) => {
    const body = installmentPayoffSchema.parse(input);
    const subscription = await lockSubscription(userId, subscriptionId);
    const plan = await Plans.findOne({ where: { subscriptionId }, lock: true });
    if (!plan || !plan.configuration.linkedSettlementEnabled)
      return planError('Early payoff requires a linked installment plan.');
    if (plan.revision !== body.revision)
      throw new ConflictError({ message: 'This plan changed. Reload it before early payoff.' });
    const item = await Items.findOne({
      where: { planId: plan.id, status: 'pending' },
      order: [['occurrenceNumber', 'ASC']],
      lock: true,
    });
    if (!item?.periodId) return planError('No pending installment period exists.');
    const period = await Periods.findByPk(item.periodId, { lock: true });
    if (!period) return planError('Installment period not found.');
    return payInstallmentPeriod({
      subscription,
      plan,
      period,
      generation: body.generation,
      createTransaction: true,
      time: body.time,
      payoff: body,
    });
  },
);
