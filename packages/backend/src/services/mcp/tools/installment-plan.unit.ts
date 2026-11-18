import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  saveInstallmentPlan,
  editInstallmentItem,
  getInstallmentPlan,
  previewInstallmentPlan,
} from '@services/subscriptions/installment-plan/plans';
import { payoffInstallment } from '@services/subscriptions/installment-plan/settle';
import { captureTools, makeExtra } from '@tests/helpers/mcp-tools';

jest.mock('@services/subscriptions/installment-plan/plans', () => ({
  saveInstallmentPlan: jest.fn(),
  editInstallmentItem: jest.fn(),
  getInstallmentPlan: jest.fn(),
  previewInstallmentPlan: jest.fn(),
}));
jest.mock('@services/subscriptions/installment-plan/settle', () => ({ payoffInstallment: jest.fn() }));
jest.mock('@services/currencies/base-currency-lock', () => ({
  isBaseCurrencyChangeLocked: jest.fn(async () => false),
}));
import {
  getInstallmentPlanTool,
  saveInstallmentPlanTool,
  editInstallmentItemTool,
  payoffInstallmentTool,
  previewInstallmentPlanTool,
} from './installment-plan';

const ID = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const write = makeExtra({ scopes: ['finance:read', 'finance:write'] });
const read = makeExtra({ scopes: ['finance:read'] });
const base = {
  subscriptionId: ID,
  revision: 0,
  totalPrincipal: 1,
  mode: 'fixed' as const,
  regular: { principal: 1, interest: 0.01, total: 1.01 },
  linkedSettlementEnabled: false,
};
const capture = (register: Parameters<typeof captureTools>[0]['register']) => captureTools({ register })[0]!;
beforeEach(() => {
  jest.clearAllMocks();
});

describe('installment MCP tools', () => {
  it('registers all read and write tools in the subscription toolset', () => {
    expect(
      [
        getInstallmentPlanTool,
        saveInstallmentPlanTool,
        editInstallmentItemTool,
        payoffInstallmentTool,
        previewInstallmentPlanTool,
      ].map((register) => capture(register).name),
    ).toEqual([
      'get_installment_plan',
      'save_installment_plan',
      'edit_installment_item',
      'payoff_installment',
      'preview_installment_plan',
    ]);
  });
  it('passes the complete validated plan and current revision to the shared service', async () => {
    await capture(saveInstallmentPlanTool).handler(base, write);
    expect(saveInstallmentPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: ID,
        input: expect.objectContaining({ revision: 0, regular: base.regular }),
      }),
    );
  });
  it('refuses read-only mutation without calling the service', async () => {
    await expect(capture(saveInstallmentPlanTool).handler(base, read)).rejects.toThrow();
    expect(saveInstallmentPlan).not.toHaveBeenCalled();
  });
  it('checks precision in the handler even when tool-side schema parsing was bypassed', async () => {
    await expect(capture(saveInstallmentPlanTool).handler({ ...base, totalPrincipal: 0.001 }, write)).rejects.toThrow();
    expect(saveInstallmentPlan).not.toHaveBeenCalled();
  });
  it('passes current generation, actual principal and final interest to early payoff', async () => {
    await capture(payoffInstallmentTool).handler(
      { subscriptionId: ID, revision: 2, generation: 3, principal: 1, interest: 0.02 },
      write,
    );
    expect(payoffInstallment).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: ID,
        input: expect.objectContaining({ revision: 2, generation: 3, principal: 1, interest: 0.02 }),
      }),
    );
  });
  it('routes an individual edit without dropping the revision or amounts', async () => {
    await capture(editInstallmentItemTool).handler(
      {
        subscriptionId: ID,
        itemId: ITEM,
        revision: 2,
        principal: 1,
        interest: 0.01,
        total: 1.01,
        dueDate: '2030-01-31',
      },
      write,
    );
    expect(editInstallmentItem).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: ID,
        itemId: ITEM,
        input: expect.objectContaining({ revision: 2, total: 1.01 }),
      }),
    );
  });
  it('allows read-only preview and plan retrieval without mutations', async () => {
    await capture(previewInstallmentPlanTool).handler(base, read);
    await capture(getInstallmentPlanTool).handler({ subscriptionId: ID }, read);
    expect(previewInstallmentPlan).toHaveBeenCalled();
    expect(getInstallmentPlan).toHaveBeenCalled();
    expect(saveInstallmentPlan).not.toHaveBeenCalled();
  });
});
