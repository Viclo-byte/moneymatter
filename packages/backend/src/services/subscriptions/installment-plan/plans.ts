import {
  ACCOUNT_TYPES,
  ACCOUNT_CATEGORIES,
  ACCOUNT_STATUSES,
  SUBSCRIPTION_TYPES,
  TRANSACTION_TYPES,
  type InstallmentPlanDetail,
  type InstallmentPlanInput,
} from '@bt/shared/types';
import { Money } from '@common/types/money';
import { ConflictError, ValidationError } from '@js/errors';
import Accounts from '@models/accounts.model';
import Categories from '@models/categories.model';
import InstallmentPlans from '@models/installment-plans.model';
import Items from '@models/installment-schedule-items.model';
import Periods from '@models/subscription-periods.model';
import Subscriptions from '@models/subscriptions.model';
import { withTransaction } from '@services/common/with-transaction';

import { findSubscriptionOrThrow } from '../helpers';
import { resolveOpenPeriodStatus } from '../resolve-period-status';
import { buildInstallmentSchedule } from './build-schedule';
import { installmentItemSchema, installmentPlanSchema } from './schema';

export const planError = (message: string): never => {
  throw new ValidationError({ message });
};
export async function lockSubscription(userId: number, subscriptionId: string) {
  return findSubscriptionOrThrow({ id: subscriptionId, userId, lock: true });
}
export async function validatePlanAccounts(subscription: Subscriptions, input: InstallmentPlanInput, lock = false) {
  if (!subscription.accountId || !subscription.expectedCurrencyCode)
    return planError('Configure the installment account and currency first.');
  const ids = [
    ...new Set([
      subscription.accountId,
      ...(input.linkedSettlementEnabled && input.destinationAccountId ? [input.destinationAccountId] : []),
    ]),
  ].toSorted();
  const accounts: Accounts[] = [];
  for (const id of ids) {
    const account = await Accounts.findOne({
      where: { id, userId: subscription.userId },
      ...(lock ? { lock: true } : {}),
    });
    if (
      !account ||
      account.type !== ACCOUNT_TYPES.system ||
      account.status !== ACCOUNT_STATUSES.active ||
      account.currencyCode !== subscription.expectedCurrencyCode ||
      [ACCOUNT_CATEGORIES.loan, ACCOUNT_CATEGORIES.vehicle].includes(account.accountCategory)
    )
      return planError(
        'Installment settlement requires active, owned, same-currency manual accounts without managed loan or vehicle balances.',
      );
    accounts.push(account);
  }
  if (input.linkedSettlementEnabled) {
    if (!input.destinationAccountId || input.destinationAccountId === subscription.accountId)
      return planError('Choose a different installment liability account.');
    if (
      !input.interestCategoryId ||
      !(await Categories.count({ where: { id: input.interestCategoryId, userId: subscription.userId } }))
    )
      return planError('Choose an interest category owned by you.');
    if (accounts.some((a) => a.excludeFromStats))
      return planError('Linked settlement accounts must allow interest to appear in spending statistics.');
  }
  return accounts;
}

export async function readPlan(subscriptionId: string): Promise<InstallmentPlanDetail | null> {
  const plan = await InstallmentPlans.findOne({ where: { subscriptionId } });
  if (!plan) return null;
  const items = await Items.findAll({ where: { planId: plan.id }, order: [['occurrenceNumber', 'ASC']] });
  return {
    revision: plan.revision,
    currencyCode: plan.currencyCode,
    sourceAccountId: plan.sourceAccountId,
    totalPrincipal: plan.totalPrincipal.toNumber(),
    configuration: plan.configuration,
    items: items.map((i) => ({
      id: i.id,
      occurrenceNumber: i.occurrenceNumber,
      dueDate: i.dueDate,
      principal: i.principal.toNumber(),
      interest: i.interest.toNumber(),
      total: i.total.toNumber(),
      status: i.status,
      periodId: i.periodId,
      generation: i.generation,
    })),
  };
}
export const getInstallmentPlan = withTransaction(
  async ({ userId, subscriptionId }: { userId: number; subscriptionId: string }) => {
    await findSubscriptionOrThrow({ id: subscriptionId, userId });
    return readPlan(subscriptionId);
  },
);

/** Only one period is live. Future amount rows do not create live periods. */
export async function advancePlan(subscription: Subscriptions, plan: InstallmentPlans) {
  const next = await Items.findOne({
    where: { planId: plan.id, status: 'pending' },
    order: [['occurrenceNumber', 'ASC']],
  });
  if (!next) {
    await subscription.update({ isActive: false, completedAt: subscription.completedAt ?? new Date() });
    return;
  }
  let period = next.periodId ? await Periods.findByPk(next.periodId) : null;
  if (!period) {
    period = await Periods.create({
      settlementGeneration: next.generation,
      subscriptionId: subscription.id,
      dueDate: next.dueDate,
      status: resolveOpenPeriodStatus({ dueDate: next.dueDate }),
    });
    await next.update({ periodId: period.id });
  }
  await subscription.update({ dueDate: next.dueDate, expectedAmount: next.total });
}

export const saveInstallmentPlan = withTransaction(
  async ({
    userId,
    subscriptionId,
    input,
  }: {
    userId: number;
    subscriptionId: string;
    input: InstallmentPlanInput;
  }) => {
    input = installmentPlanSchema.parse(input);
    const subscription = await lockSubscription(userId, subscriptionId);
    if (
      subscription.type !== SUBSCRIPTION_TYPES.installment ||
      subscription.transactionType !== TRANSACTION_TYPES.expense ||
      !subscription.maxOccurrences ||
      !subscription.dueDate
    )
      return planError('An expense installment with a finite schedule is required.');
    if (subscription.matchingRules.rules.length)
      return planError('Disable transaction matching before enabling an installment plan.');
    const existing = await InstallmentPlans.findOne({ where: { subscriptionId }, lock: true });
    if (input.revision !== (existing?.revision ?? 0))
      throw new ConflictError({ message: 'This installment plan changed. Reload it before saving.' });
    const previous = existing
      ? await Items.findAll({ where: { planId: existing.id }, order: [['occurrenceNumber', 'ASC']], lock: true })
      : [];
    if (previous.some((i) => i.status === 'cancelled'))
      return planError('A settled early payoff plan cannot be replaced.');
    if (!existing && (await Periods.count({ where: { subscriptionId, status: ['paid', 'skipped'] } })))
      return planError(
        'Historical installments need explicit reconciliation. Create a plan for the remaining balance rather than guessing past principal and interest.',
      );
    if (input.sourceAccountId && input.sourceAccountId !== subscription.accountId) {
      if (previous.some((item) => item.status === 'paid'))
        return planError('Paid installments lock the source account.');
      await subscription.update({ accountId: input.sourceAccountId });
    }
    const accounts = await validatePlanAccounts(subscription, input, true);
    const schedule = buildInstallmentSchedule(input, {
      frequency: subscription.frequency,
      intervalUnit: subscription.intervalUnit,
      intervalCount: subscription.intervalCount,
      anchorDay: subscription.anchorDay,
      maxOccurrences: subscription.maxOccurrences,
      dueDate: previous[0]?.dueDate ?? subscription.dueDate,
    });
    const paid = previous.filter((i) => i.status === 'paid');
    if (
      paid.length &&
      existing &&
      (existing.sourceAccountId !== subscription.accountId ||
        existing.configuration.linkedSettlementEnabled !== input.linkedSettlementEnabled ||
        existing.configuration.destinationAccountId !== input.destinationAccountId ||
        existing.configuration.interestCategoryId !== input.interestCategoryId ||
        !existing.totalPrincipal.equals(Money.fromDecimal(input.totalPrincipal)))
    )
      return planError('Settled history locks the accounts, settlement mode and principal total.');
    for (const item of paid) {
      const proposed = schedule[item.occurrenceNumber - 1];
      if (
        !proposed ||
        proposed.dueDate !== item.dueDate ||
        !proposed.principal.equals(item.principal) ||
        !proposed.interest.equals(item.interest)
      )
        return planError('Paid installments cannot be overwritten. Edit only pending rows.');
    }
    const remaining = Money.sum(
      schedule.filter((_, index) => previous[index]?.status !== 'paid').map((i) => i.principal),
    );
    if (input.linkedSettlementEnabled) {
      const destination = accounts.find((a) => a.id === input.destinationAccountId)!;
      if (!destination.currentBalance.negate().equals(remaining))
        return planError(
          'The liability balance must match the remaining plan principal. Reconcile the account before saving.',
        );
    }
    const values = {
      subscriptionId,
      sourceAccountId: subscription.accountId!,
      currencyCode: subscription.expectedCurrencyCode!,
      totalPrincipal: Money.fromDecimal(input.totalPrincipal),
      revision: input.revision + 1,
      configuration: { ...input, revision: input.revision + 1 },
    };
    const plan = existing ? await existing.update(values) : await InstallmentPlans.create(values);
    for (const [index, value] of schedule.entries()) {
      const item = previous[index];
      if (item?.status === 'paid') continue;
      if (item) {
        await item.update({ ...value, generation: item.generation + 1 });
        if (item.periodId)
          await Periods.update(
            {
              dueDate: value.dueDate,
              settlementGeneration: item.generation,
              status: resolveOpenPeriodStatus({ dueDate: value.dueDate }),
            },
            { where: { id: item.periodId } },
          );
      } else await Items.create({ ...value, planId: plan.id });
    }
    if (!existing) {
      const open = await Periods.findOne({ where: { subscriptionId, status: ['upcoming', 'overdue'] }, lock: true });
      if (open) {
        await open.update({
          dueDate: schedule[0]!.dueDate,
          status: resolveOpenPeriodStatus({ dueDate: schedule[0]!.dueDate }),
        });
        await Items.update({ periodId: open.id }, { where: { planId: plan.id, occurrenceNumber: 1 } });
      }
    }
    await advancePlan(subscription, plan);
    return readPlan(subscriptionId);
  },
);

export const editInstallmentItem = withTransaction(
  async ({
    userId,
    subscriptionId,
    itemId,
    input,
  }: {
    userId: number;
    subscriptionId: string;
    itemId: string;
    input: unknown;
  }) => {
    const change = installmentItemSchema.parse(input);
    await lockSubscription(userId, subscriptionId);
    const detail = await readPlan(subscriptionId);
    if (!detail) return planError('Installment plan not found.');
    if (detail.revision !== change.revision)
      throw new ConflictError({ message: 'This installment plan changed. Reload it before saving.' });
    const selected = detail.items.find((i) => i.id === itemId);
    if (!selected || selected.status !== 'pending') return planError('Only pending installments may be edited.');
    const schedule = detail.items.map((i) => ({
      principal: i.principal,
      interest: i.interest,
      total: i.total,
      dueDate: i.dueDate,
    }));
    const index = selected.occurrenceNumber - 1;
    schedule[index] = change;
    // Preserve every explicitly entered future amount. Only the final residual is adjusted.
    const last = schedule.length - 1;
    if (index !== last && detail.items[last]!.status === 'pending') {
      const remaining = Money.fromDecimal(detail.totalPrincipal).subtract(
        Money.sum(schedule.slice(0, last).map((i) => Money.fromDecimal(i.principal))),
      );
      if (remaining.isNegative()) return planError('This change would overpay the principal.');
      schedule[last] = {
        ...schedule[last]!,
        principal: remaining.toNumber(),
        total: remaining.add(Money.fromDecimal(schedule[last]!.interest)).toNumber(),
      };
    }
    return saveInstallmentPlan({
      userId,
      subscriptionId,
      input: { ...detail.configuration, revision: change.revision, mode: 'custom', schedule },
    });
  },
);

export const previewInstallmentPlan = withTransaction(
  async ({ userId, subscriptionId, input }: { userId: number; subscriptionId: string; input: unknown }) => {
    const configuration = installmentPlanSchema.parse(input);
    const subscription = await findSubscriptionOrThrow({ id: subscriptionId, userId });
    if (subscription.type !== SUBSCRIPTION_TYPES.installment || !subscription.maxOccurrences || !subscription.dueDate)
      return planError('Configure the installment schedule first.');
    const first = await Items.findOne({
      where: { planId: (await InstallmentPlans.findOne({ where: { subscriptionId } }))?.id ?? null },
      order: [['occurrenceNumber', 'ASC']],
    });
    return buildInstallmentSchedule(configuration, {
      frequency: subscription.frequency,
      intervalUnit: subscription.intervalUnit,
      intervalCount: subscription.intervalCount,
      anchorDay: subscription.anchorDay,
      maxOccurrences: subscription.maxOccurrences,
      dueDate: first?.dueDate ?? subscription.dueDate,
    }).map((i) => ({
      principal: i.principal.toNumber(),
      interest: i.interest.toNumber(),
      total: i.total.toNumber(),
      dueDate: i.dueDate,
    }));
  },
);
