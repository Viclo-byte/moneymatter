import {
  ACCOUNT_CATEGORIES,
  SUBSCRIPTION_FREQUENCIES,
  SUBSCRIPTION_TYPES,
  TRANSACTION_TRANSFER_NATURE,
  TRANSACTION_TYPES,
  type InstallmentPlanDetail,
  type InstallmentPlanInput,
} from '@bt/shared/types';
import { Money } from '@common/types/money';
import { describe, expect, it, jest } from '@jest/globals';
import Accounts from '@models/accounts.model';
import { connection } from '@models/index';
import Settlements from '@models/installment-settlements.model';
import Periods from '@models/subscription-periods.model';
import { findTransactions } from '@models/transactions-query';
import { exportUserBackup } from '@services/backup/export-backup.service';
import { restoreUserBackup } from '@services/backup/restore/restore-backup.service';
import { statsTransactions } from '@services/stats/stats-transactions';
import * as helpers from '@tests/helpers';
import { makeRequest } from '@tests/helpers/common';

import { processAutoRecordPeriods } from '../process-auto-record';
import { getInstallmentPlan, editInstallmentItem } from './plans';

async function setup({ count = 24, totalPrincipal = 4786.34, linked = true, today = false } = {}) {
  const card = await helpers.createAccount({
    payload: helpers.buildAccountPayload({
      name: 'Installment test card',
      accountCategory: ACCOUNT_CATEGORIES.creditCard,
      initialBalance: -1000,
    }),
    raw: true,
  });
  const debt = await helpers.createAccount({
    payload: helpers.buildAccountPayload({ name: 'Installment test liability', initialBalance: -totalPrincipal }),
    raw: true,
  });
  const sub = await helpers.createSubscription({
    name: 'Installment test',
    type: SUBSCRIPTION_TYPES.installment,
    frequency: SUBSCRIPTION_FREQUENCIES.monthly,
    startDate: today ? new Date().toISOString().slice(0, 10) : '2030-01-31',
    dueDate: today ? new Date().toISOString().slice(0, 10) : '2030-01-31',
    maxOccurrences: count,
    accountId: card.id,
    expectedAmount: 229.1,
    expectedCurrencyCode: global.BASE_CURRENCY.code,
    categoryId: global.DEFAULT_CATEGORY_ID,
    raw: true,
  });
  const input: InstallmentPlanInput = {
    revision: 0,
    totalPrincipal,
    mode: 'fixed',
    regular: { principal: 199.43, interest: 29.67, total: 229.1 },
    first: { principal: 199.45, interest: 27.73, total: 227.18 },
    last: { interest: 29.67 },
    linkedSettlementEnabled: linked,
    destinationAccountId: debt.id,
    interestCategoryId: global.DEFAULT_CATEGORY_ID,
  };
  const result = await makeRequest<InstallmentPlanDetail>({
    method: 'put',
    url: `/subscriptions/${sub.id}/installment-plan`,
    payload: input,
  });
  expect(result.statusCode).toBe(200);
  const plan = result.body.response;
  return { card, debt, sub, plan, input };
}
async function pay(id: string, periodId: string, generation = 0) {
  return makeRequest({
    method: 'post',
    url: `/subscriptions/${id}/periods/${periodId}/pay`,
    payload: { createTransaction: true, generation },
  });
}
async function balances(cardId: string, debtId: string) {
  const card = await Accounts.findByPk(cardId);
  const debt = await Accounts.findByPk(debtId);
  return [card!.currentBalance.toNumber(), debt!.currentBalance.toNumber()];
}
async function rows(userId: number) {
  return findTransactions({
    access: { creator: userId },
    planned: 'exclude',
    balanceAdjustments: 'exclude',
    completeness: 'all',
  });
}

describe('installment liability settlement', () => {
  it('creates exactly a transfer pair and one interest expense; debt signs and statistics are correct', async () => {
    const { card, debt, sub, plan } = await setup();
    expect(plan.items).toHaveLength(24);
    expect(Money.sum(plan.items.map((i) => Money.fromDecimal(i.principal))).toNumber()).toBe(4786.34);
    const periodId = plan.items[0]!.periodId!;
    expect((await pay(sub.id, periodId)).statusCode).toBe(200);
    expect(await balances(card.id, debt.id)).toEqual([-1227.18, -4586.89]);
    const transactions = await rows(card.userId);
    expect(transactions).toHaveLength(3);
    const pair = transactions.filter((tx) => tx.transferNature === TRANSACTION_TRANSFER_NATURE.common_transfer);
    expect(pair).toHaveLength(2);
    expect(pair[0]!.transferId).toBeTruthy();
    expect(pair[0]!.transferId).toBe(pair[1]!.transferId);
    expect(pair.find((tx) => tx.accountId === card.id)!.transactionType).toBe(TRANSACTION_TYPES.expense);
    expect(pair.find((tx) => tx.accountId === debt.id)!.transactionType).toBe(TRANSACTION_TYPES.income);
    const stats = await statsTransactions({
      access: { creator: card.userId },
      planned: 'exclude',
      refunds: 'ignore',
      window: {},
    });
    expect(stats.rows).toHaveLength(1);
    expect(stats.rows[0]!.amount.toNumber()).toBe(27.73);
    expect(stats.rows[0]!.transactionType).toBe(TRANSACTION_TYPES.expense);
    const updated = await getInstallmentPlan({ userId: card.userId, subscriptionId: sub.id });
    expect(updated!.items[1]!.total).toBe(229.1);
    expect(updated!.items[1]!.periodId).toBeTruthy();
    expect(await Periods.count({ where: { subscriptionId: sub.id, status: ['upcoming', 'overdue'] } })).toBe(1);
  });
  it('serializes concurrent payments and treats retry as the same settlement', async () => {
    const { card, debt, sub, plan } = await setup();
    const results = await Promise.all([pay(sub.id, plan.items[0]!.periodId!), pay(sub.id, plan.items[0]!.periodId!)]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(await rows(card.userId)).toHaveLength(3);
    expect(await Settlements.count({ where: { state: 'settled' } })).toBe(1);
    expect(await balances(card.id, debt.id)).toEqual([-1227.18, -4586.89]);
  });
  it('rolls back transfer legs, interest and balances when marking the period fails', async () => {
    const { card, debt, sub, plan } = await setup();
    const original = Periods.prototype.update;
    const spy = jest.spyOn(Periods.prototype, 'update').mockImplementation(function (
      this: Periods,
      ...args: Parameters<Periods['update']>
    ) {
      if (args[0].status === 'paid') throw new Error('Injected installment period failure');
      return original.apply(this, args);
    });
    try {
      expect((await pay(sub.id, plan.items[0]!.periodId!)).statusCode).toBeGreaterThanOrEqual(400);
    } finally {
      spy.mockRestore();
    }
    expect(await rows(card.userId)).toHaveLength(0);
    expect(await balances(card.id, debt.id)).toEqual([-1000, -4786.34]);
    expect(await Settlements.count()).toBe(0);
    expect((await getInstallmentPlan({ userId: card.userId, subscriptionId: sub.id }))!.items[0]!.status).toBe(
      'pending',
    );
  });
  it('protects individual rows, reverts all three rows, and rejects stale generation retries', async () => {
    const { card, debt, sub, plan } = await setup();
    const id = plan.items[0]!.periodId!;
    expect((await pay(sub.id, id)).statusCode).toBe(200);
    const transaction = (await rows(card.userId))[0]!;
    expect(
      (await makeRequest({ method: 'delete', url: `/transactions/${transaction.id}` })).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await makeRequest({ method: 'post', url: `/subscriptions/${sub.id}/periods/${id}/revert` })).statusCode,
    ).toBe(200);
    expect(await balances(card.id, debt.id)).toEqual([-1000, -4786.34]);
    expect(await rows(card.userId)).toHaveLength(0);
    expect((await pay(sub.id, id, 0)).statusCode).toBe(409);
    expect((await pay(sub.id, id, 1)).statusCode).toBe(200);
    expect(await rows(card.userId)).toHaveLength(3);
  });
  it('edits only unpaid rows, preserves paid amounts and recalculates the final cent residual', async () => {
    const { card, sub, plan } = await setup();
    expect((await pay(sub.id, plan.items[0]!.periodId!)).statusCode).toBe(200);
    const current = (await getInstallmentPlan({ userId: card.userId, subscriptionId: sub.id }))!;
    const item = current.items[1]!;
    const result = await editInstallmentItem({
      userId: card.userId,
      subscriptionId: sub.id,
      itemId: item.id,
      input: { revision: current.revision, principal: 199.44, interest: 29.66, total: 229.1, dueDate: item.dueDate },
    });
    expect(result!.items[0]!.principal).toBe(199.45);
    expect(result!.items[23]!.principal).toBe(199.42);
    expect((await rows(card.userId)).find((tx) => tx.transferNature === 'not_transfer')!.amount.toNumber()).toBe(27.73);
    await expect(
      editInstallmentItem({
        userId: card.userId,
        subscriptionId: sub.id,
        itemId: current.items[0]!.id,
        input: {
          revision: result!.revision,
          principal: 199,
          interest: 1,
          total: 200,
          dueDate: current.items[0]!.dueDate,
        },
      }),
    ).rejects.toThrow();
  });
  it('early payoff cancels future rows, keeps debit repayment separate, and restores the plan on revert', async () => {
    const { card, debt, sub, plan } = await setup();
    const response = await makeRequest({
      method: 'post',
      url: `/subscriptions/${sub.id}/installment-plan/payoff`,
      payload: { revision: plan.revision, generation: 0, principal: 4786.34, interest: 10 },
    });
    expect(response.statusCode).toBe(200);
    expect(await balances(card.id, debt.id)).toEqual([-5796.34, 0]);
    const paid = (await getInstallmentPlan({ userId: card.userId, subscriptionId: sub.id }))!;
    expect(paid.items.filter((i) => i.status === 'cancelled')).toHaveLength(23);
    expect(await rows(card.userId)).toHaveLength(3);
    expect(
      (await makeRequest({ method: 'post', url: `/subscriptions/${sub.id}/periods/${plan.items[0]!.periodId}/revert` }))
        .statusCode,
    ).toBe(200);
    const restored = (await getInstallmentPlan({ userId: card.userId, subscriptionId: sub.id }))!;
    expect(restored.items.filter((i) => i.status === 'pending')).toHaveLength(24);
    expect(restored.items[0]!.principal).toBe(199.45);
    expect(await balances(card.id, debt.id)).toEqual([-1000, -4786.34]);
  });
  it('uses the existing auto-record path without creating the full amount again', async () => {
    const { card, debt, sub } = await setup({ today: true });
    const enabled = await helpers.updateSubscription({ id: sub.id, autoRecord: true, raw: true });
    expect(enabled.autoRecord).toBe(true);
    expect((await processAutoRecordPeriods()).booked).toBe(1);
    expect((await processAutoRecordPeriods()).booked).toBe(0);
    expect(await rows(card.userId)).toHaveLength(3);
    expect(await balances(card.id, debt.id)).toEqual([-1227.18, -4586.89]);
  });
  it('does not split non-linked plans into transfers', async () => {
    const { card, debt, sub, plan } = await setup({ linked: false });
    expect((await pay(sub.id, plan.items[0]!.periodId!)).statusCode).toBe(200);
    const transactions = await rows(card.userId);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.amount.toNumber()).toBe(227.18);
    expect(await balances(card.id, debt.id)).toEqual([-1227.18, -4786.34]);
  });
  it('round-trips paid history, pending plans and guarded transfers through a full backup restore', async () => {
    const { card, debt, sub, plan } = await setup();
    expect((await pay(sub.id, plan.items[0]!.periodId!)).statusCode).toBe(200);
    const before = await getInstallmentPlan({ userId: card.userId, subscriptionId: sub.id });
    const backup = await exportUserBackup({ userId: card.userId });
    const restored = await restoreUserBackup({ userId: card.userId, fileContent: backup.buffer.toString('base64') });
    expect(restored.insertedByTable['installment-plans']).toBe(1);
    expect(restored.insertedByTable['installment-settlements']).toBe(1);
    expect(await getInstallmentPlan({ userId: card.userId, subscriptionId: sub.id })).toEqual(before);
    expect(await balances(card.id, debt.id)).toEqual([-1227.18, -4586.89]);
    expect(
      (await makeRequest({ method: 'post', url: `/subscriptions/${sub.id}/periods/${plan.items[0]!.periodId}/revert` }))
        .statusCode,
    ).toBe(200);
    expect(await balances(card.id, debt.id)).toEqual([-1000, -4786.34]);
  }, 30000);

  it('finishes all 24 periods with exact principal and no negative final residual', async () => {
    const { card, debt, sub } = await setup();
    let lastPeriod = '';
    for (let occurrence = 0; occurrence < 24; occurrence++) {
      const detail = (await getInstallmentPlan({ userId: card.userId, subscriptionId: sub.id }))!;
      const item = detail.items.find((i) => i.status === 'pending')!;
      lastPeriod = item.periodId!;
      expect((await pay(sub.id, item.periodId!, item.generation)).statusCode).toBe(200);
    }
    expect((await Accounts.findByPk(debt.id))!.currentBalance.toNumber()).toBe(0);
    const detail = (await getInstallmentPlan({ userId: card.userId, subscriptionId: sub.id }))!;
    expect(detail.items.every((i) => i.status === 'paid')).toBe(true);
    expect(await Periods.count({ where: { subscriptionId: sub.id, status: ['upcoming', 'overdue'] } })).toBe(0);
    const transactions = await rows(card.userId);
    expect(transactions).toHaveLength(72);
    expect(Money.sum(transactions.filter((tx) => tx.accountId === debt.id).map((tx) => tx.amount)).toNumber()).toBe(
      4786.34,
    );
    expect((await pay(sub.id, lastPeriod)).statusCode).toBe(200);
    expect(await rows(card.userId)).toHaveLength(72);
  }, 30000);

  it.each<[string, number, number, number]>([
    ['zero interest', 199.43, 0, 2],
    ['zero principal', 0, 29.67, 1],
  ])('handles %s without creating a zero-amount transaction', async (_label, principal, interest, expectedRows) => {
    const { card, debt, sub, plan, input } = await setup({ count: 2, totalPrincipal: 398.86 });
    const schedule = [
      { principal, interest, total: Money.fromDecimal(principal).add(Money.fromDecimal(interest)).toNumber() },
      {
        principal: Money.fromDecimal(398.86).subtract(Money.fromDecimal(principal)).toNumber(),
        interest: 0,
        total: Money.fromDecimal(398.86).subtract(Money.fromDecimal(principal)).toNumber(),
      },
    ];
    const saved = await makeRequest<InstallmentPlanDetail>({
      method: 'put',
      url: `/subscriptions/${sub.id}/installment-plan`,
      payload: { ...input, revision: plan.revision, mode: 'custom', schedule },
    });
    expect(saved.statusCode).toBe(200);
    const item = saved.body.response.items[0]!;
    expect((await pay(sub.id, item.periodId!, item.generation)).statusCode).toBe(200);
    expect(await rows(card.userId)).toHaveLength(expectedRows);
    expect(await balances(card.id, debt.id)).toEqual([
      Money.fromDecimal(-1000).subtract(Money.fromDecimal(principal)).subtract(Money.fromDecimal(interest)).toNumber(),
      Money.fromDecimal(-398.86).add(Money.fromDecimal(principal)).toNumber(),
    ]);
  });

  it('keeps a real debit-card repayment when the independent installment settlement is reverted', async () => {
    const { card, debt, sub, plan } = await setup();
    expect((await pay(sub.id, plan.items[0]!.periodId!)).statusCode).toBe(200);
    const bank = await helpers.createAccount({
      payload: helpers.buildAccountPayload({ name: 'Installment repayment debit account', initialBalance: 10000 }),
      raw: true,
    });
    const repayment = await helpers.createTransaction({
      payload: helpers.buildTransactionPayload({
        accountId: bank.id,
        destinationAccountId: card.id,
        destinationAmount: 227.18,
        amount: 227.18,
        transactionType: TRANSACTION_TYPES.expense,
        transferNature: TRANSACTION_TRANSFER_NATURE.common_transfer,
      }),
      raw: true,
    });
    expect(repayment).toHaveLength(2);
    expect(await balances(card.id, debt.id)).toEqual([-1000, -4586.89]);
    expect(
      (await makeRequest({ method: 'post', url: `/subscriptions/${sub.id}/periods/${plan.items[0]!.periodId}/revert` }))
        .statusCode,
    ).toBe(200);
    expect(await balances(card.id, debt.id)).toEqual([-772.82, -4786.34]);
    expect((await Accounts.findByPk(bank.id))!.currentBalance.toNumber()).toBe(9772.82);
    expect(await rows(card.userId)).toHaveLength(2);
  });

  it('rejects skip, unlink, manual amount overrides and a stale edit without changing the ledger', async () => {
    const { card, sub, plan } = await setup();
    const id = plan.items[0]!.periodId!;
    for (const action of ['skip', 'unlink'])
      expect(
        (await makeRequest({ method: 'post', url: `/subscriptions/${sub.id}/periods/${id}/${action}` })).statusCode,
      ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await makeRequest({
          method: 'post',
          url: `/subscriptions/${sub.id}/periods/${id}/pay`,
          payload: { createTransaction: true, generation: 0, amount: 227.18 },
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await makeRequest({
          method: 'put',
          url: `/subscriptions/${sub.id}/installment-plan/items/${plan.items[1]!.id}`,
          payload: { revision: 0, principal: 199.43, interest: 29.67, total: 229.1, dueDate: plan.items[1]!.dueDate },
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(await rows(card.userId)).toHaveLength(0);
  });

  it('restores into another user with independent transfer tokens and never alters the source on revert', async () => {
    const { card, debt, sub, plan } = await setup();
    expect((await pay(sub.id, plan.items[0]!.periodId!)).statusCode).toBe(200);
    const original = (await rows(card.userId)).find((tx) => tx.transferId)!;
    const backup = await exportUserBackup({ userId: card.userId });
    const target = await helpers.provisionSecondUserWithBaseCurrency();
    await helpers.asUser({
      cookies: target.cookies,
      fn: async () => {
        const restore = await helpers.withSelfHost(() =>
          helpers.restoreBackup({ fileContent: backup.buffer.toString('base64') }),
        );
        expect(restore.statusCode).toBe(200);
        expect((await helpers.waitForRestore({ jobId: restore.jobId! })).status).toBe('completed');
        const subscriptions = await helpers.getSubscriptions({ raw: true });
        const copied = subscriptions.find((row) => row.name === 'Installment test')!;
        const copiedAccounts = await helpers.getAccounts();
        const owner = copiedAccounts[0]!.userId;
        const detail = (await getInstallmentPlan({ userId: owner, subscriptionId: copied.id }))!;
        const pair = (await rows(owner)).filter((tx) => tx.transferId);
        expect(pair).toHaveLength(2);
        expect(pair[0]!.transferId).toBe(pair[1]!.transferId);
        expect(pair[0]!.transferId).not.toBe(original.transferId);
        expect(
          (
            await makeRequest({
              method: 'post',
              url: `/subscriptions/${copied.id}/periods/${detail.items[0]!.periodId}/revert`,
            })
          ).statusCode,
        ).toBe(200);
        expect(await rows(owner)).toHaveLength(0);
      },
    });
    expect(await balances(card.id, debt.id)).toEqual([-1227.18, -4586.89]);
    expect(await rows(card.userId)).toHaveLength(3);
  }, 30000);

  it('selects a different owned source before the first payment and locks it once history exists', async () => {
    const { card, debt, sub, plan, input } = await setup();
    const source = await helpers.createAccount({
      payload: helpers.buildAccountPayload({
        name: 'Alternative test credit card',
        accountCategory: ACCOUNT_CATEGORIES.creditCard,
        initialBalance: -50,
      }),
      raw: true,
    });
    const saved = await makeRequest<InstallmentPlanDetail>({
      method: 'put',
      url: `/subscriptions/${sub.id}/installment-plan`,
      payload: { ...input, revision: plan.revision, sourceAccountId: source.id },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body.response.sourceAccountId).toBe(source.id);
    const item = saved.body.response.items[0]!;
    expect((await pay(sub.id, item.periodId!, item.generation)).statusCode).toBe(200);
    expect(await balances(source.id, debt.id)).toEqual([-277.18, -4586.89]);
    const current = (await getInstallmentPlan({ userId: card.userId, subscriptionId: sub.id }))!;
    const changed = await makeRequest({
      method: 'put',
      url: `/subscriptions/${sub.id}/installment-plan`,
      payload: { ...input, revision: current.revision, sourceAccountId: card.id },
    });
    expect(changed.statusCode).toBeGreaterThanOrEqual(400);
    expect((await Accounts.findByPk(card.id))!.currentBalance.toNumber()).toBe(-1000);
  });

  it('protects database writes even when ordinary transaction services are bypassed', async () => {
    const { sub, plan, card } = await setup();
    expect((await pay(sub.id, plan.items[0]!.periodId!)).statusCode).toBe(200);
    const id = (await rows(card.userId))[0]!.id;
    await expect(
      connection.sequelize.query('UPDATE "Transactions" SET "amount" = 1 WHERE "id" = :id', { replacements: { id } }),
    ).rejects.toThrow('Use the installment settlement');
  });
});
