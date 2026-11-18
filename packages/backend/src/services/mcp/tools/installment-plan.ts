import { recordId } from '@common/lib/zod/custom-types';
import { transactionTimeSchema } from '@controllers/transactions.controller/schemas';
import {
  getInstallmentPlan,
  saveInstallmentPlan,
  editInstallmentItem,
  previewInstallmentPlan,
} from '@services/subscriptions/installment-plan/plans';
import {
  installmentPlanSchema,
  installmentItemSchema,
  installmentPayoffSchema,
} from '@services/subscriptions/installment-plan/schema';
import { payoffInstallment } from '@services/subscriptions/installment-plan/settle';

import { defineTool } from '../define-tool';

export const getInstallmentPlanTool = defineTool({
  name: 'get_installment_plan',
  toolset: 'subscriptions',
  access: 'read',
  description:
    'Read every installment principal, interest, total, due date and status, plus revision and next payment generation. Credit card transfers principal to the independent liability account; actual bank repayment is separate.',
  input: { subscriptionId: recordId() },
  run: ({ userId, args }) => getInstallmentPlan({ userId, subscriptionId: args.subscriptionId }),
});
export const saveInstallmentPlanTool = defineTool({
  name: 'save_installment_plan',
  toolset: 'subscriptions',
  access: 'write',
  description:
    'Create or replace an expense installment amount plan. Revision 0 creates; otherwise supply current revision. Fixed mode supports first, regular and final residual amounts; custom mode requires every row. Never replaces paid history. Linked settlement requires owned same-currency manual accounts; source is the installment subscription credit card and destination is a separate negative liability. Managed loans are unsupported. No historical payment conversion.',
  input: { subscriptionId: recordId(), ...installmentPlanSchema.shape },
  run: ({ userId, args }) => {
    const { subscriptionId, ...input } = args;
    return saveInstallmentPlan({ userId, subscriptionId, input: installmentPlanSchema.parse(input) });
  },
});
export const editInstallmentItemTool = defineTool({
  name: 'edit_installment_item',
  toolset: 'subscriptions',
  access: 'write',
  description:
    'Edit one unpaid installment with current plan revision. Principal plus interest must equal total. Recalculates final unpaid principal residual and preserves paid history. Dates must remain increasing.',
  input: { subscriptionId: recordId(), itemId: recordId(), ...installmentItemSchema.shape },
  run: ({ userId, args }) => {
    const { subscriptionId, itemId, ...input } = args;
    return editInstallmentItem({ userId, subscriptionId, itemId, input });
  },
});
export const payoffInstallmentTool = defineTool({
  name: 'payoff_installment',
  toolset: 'subscriptions',
  access: 'write',
  description:
    'Settle all remaining principal and actual final interest or fees through the existing internal transfer plus separate credit-card expense. Uses current revision and generation. Cancels future installments atomically; does not generate a debit-card repayment. Revert the period to undo the whole payoff.',
  input: { subscriptionId: recordId(), ...installmentPayoffSchema.shape, time: transactionTimeSchema().optional() },
  run: ({ userId, args }) => {
    const { subscriptionId, ...input } = args;
    return payoffInstallment({ userId, subscriptionId, input });
  },
});

export const previewInstallmentPlanTool = defineTool({
  name: 'preview_installment_plan',
  toolset: 'subscriptions',
  access: 'read',
  description:
    'Expand a proposed installment plan without saving or creating transactions. Validates principal plus interest, exact final residual and ordered dates. Returns all schedule rows for review before save_installment_plan.',
  input: { subscriptionId: recordId(), ...installmentPlanSchema.shape },
  run: ({ userId, args }) => {
    const { subscriptionId, ...input } = args;
    return previewInstallmentPlan({ userId, subscriptionId, input });
  },
});
