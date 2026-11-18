import { SUBSCRIPTION_FREQUENCIES, type InstallmentPlanInput } from '@bt/shared/types';
import { Money } from '@common/types/money';
import { describe, expect, it } from '@jest/globals';

import { buildInstallmentSchedule } from './build-schedule';
import { installmentPlanSchema } from './schema';

const input = (): InstallmentPlanInput => ({
  revision: 0,
  mode: 'fixed',
  totalPrincipal: 4786.34,
  regular: { principal: 199.43, interest: 29.67, total: 229.1 },
  first: { principal: 199.45, interest: 27.73, total: 227.18 },
  last: { interest: 0.01 },
  linkedSettlementEnabled: false,
});
const subscription = {
  maxOccurrences: 24,
  dueDate: '2026-01-31',
  frequency: SUBSCRIPTION_FREQUENCIES.monthly,
  intervalUnit: null,
  intervalCount: null,
  anchorDay: 31,
};

describe('installment schedule amounts', () => {
  it('preserves first-payment differences and clamps dates without drifting the month-end anchor', () => {
    const rows = buildInstallmentSchedule(input(), subscription);
    expect(rows).toHaveLength(24);
    expect(rows[0]!.total.toNumber()).toBe(227.18);
    expect(rows[0]!.principal.toNumber()).toBe(199.45);
    expect(rows[0]!.interest.toNumber()).toBe(27.73);
    expect(rows[1]!.total.toNumber()).toBe(229.1);
    expect(rows[1]!.dueDate).toBe('2026-02-28');
    expect(rows[2]!.dueDate).toBe('2026-03-31');
    expect(rows[23]!.principal.toNumber()).toBe(199.43);
    expect(rows[23]!.interest.toNumber()).toBe(0.01);
    expect(Money.sum(rows.map((r) => r.principal)).toNumber()).toBe(4786.34);
  });
  it('assigns the final one-cent residual without floating-point loss', () => {
    const rows = buildInstallmentSchedule({ ...input(), totalPrincipal: 4786.35 }, subscription);
    expect(rows[23]!.principal.toNumber()).toBe(199.44);
    expect(Money.sum(rows.map((r) => r.principal)).toNumber()).toBe(4786.35);
  });
  it('preserves independently customized amounts and dates', () => {
    const rows = buildInstallmentSchedule(
      {
        ...input(),
        totalPrincipal: 3,
        mode: 'custom',
        schedule: [
          { principal: 1.01, interest: 0.09, total: 1.1, dueDate: '2026-02-01' },
          { principal: 1.99, interest: 0.02, total: 2.01, dueDate: '2026-03-09' },
        ],
      },
      { ...subscription, maxOccurrences: 2 },
    );
    expect(rows.map((r) => [r.principal.toNumber(), r.interest.toNumber(), r.total.toNumber(), r.dueDate])).toEqual([
      [1.01, 0.09, 1.1, '2026-02-01'],
      [1.99, 0.02, 2.01, '2026-03-09'],
    ]);
  });
  it.each([
    ['mismatched first total', { first: { principal: 199.45, interest: 27.73, total: 227.19 } }],
    ['overpaid principal', { totalPrincipal: 10 }],
    ['wrong final principal', { last: { interest: 0, principal: 199.44 } }],
    ['wrong final total', { last: { interest: 0, total: 1 } }],
    ['missing custom rows', { mode: 'custom' }],
    [
      'non-increasing dates',
      {
        first: { principal: 199.45, interest: 27.73, total: 227.18, dueDate: '2030-01-31' },
        last: { interest: 0, dueDate: '2027-01-01' },
      },
    ],
  ])('rejects %s', (_, change) => {
    expect(() => buildInstallmentSchedule({ ...input(), ...change } as InstallmentPlanInput, subscription)).toThrow();
  });
  it('rejects zero-total rows and wrong custom principal sums', () => {
    const base = { ...input(), mode: 'custom' as const, totalPrincipal: 1 };
    expect(() =>
      buildInstallmentSchedule(
        { ...base, schedule: [{ principal: 0, interest: 0, total: 0 }] },
        { ...subscription, maxOccurrences: 1 },
      ),
    ).toThrow();
    expect(() =>
      buildInstallmentSchedule(
        { ...base, schedule: [{ principal: 0.99, interest: 0.01, total: 1 }] },
        { ...subscription, maxOccurrences: 1 },
      ),
    ).toThrow();
  });
  it('accepts zero interest or a positive interest-only payment', () => {
    const rows = buildInstallmentSchedule(
      {
        ...input(),
        mode: 'custom',
        totalPrincipal: 1,
        schedule: [
          { principal: 0, interest: 0.01, total: 0.01 },
          { principal: 1, interest: 0, total: 1 },
        ],
      },
      { ...subscription, maxOccurrences: 2 },
    );
    expect(rows[0]!.principal.isZero()).toBe(true);
    expect(rows[1]!.interest.isZero()).toBe(true);
  });
  it.each([NaN, Infinity, -1, 0.001, 1_000_000_001])(
    'rejects invalid money at both REST and MCP boundary: %s',
    (principal) => {
      expect(installmentPlanSchema.safeParse({ ...input(), totalPrincipal: principal }).success).toBe(false);
    },
  );
});
