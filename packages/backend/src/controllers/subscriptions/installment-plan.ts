import { recordId } from '@common/lib/zod/custom-types';
import { createController } from '@controllers/helpers/controller-factory';
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
import { z } from 'zod';

const planParams = z.object({ id: recordId() });
export const getPlan = createController(z.object({ params: planParams }), async ({ user, params }) => ({
  data: await getInstallmentPlan({ userId: user.id, subscriptionId: params.id }),
}));
export const savePlan = createController(
  z.object({ params: planParams, body: installmentPlanSchema }),
  async ({ user, params, body }) => ({
    data: await saveInstallmentPlan({ userId: user.id, subscriptionId: params.id, input: body }),
  }),
);
export const editItem = createController(
  z.object({ params: planParams.extend({ itemId: recordId() }), body: installmentItemSchema }),
  async ({ user, params, body }) => ({
    data: await editInstallmentItem({ userId: user.id, subscriptionId: params.id, itemId: params.itemId, input: body }),
  }),
);
export const payoff = createController(
  z.object({ params: planParams, body: installmentPayoffSchema }),
  async ({ user, params, body }) => ({
    data: await payoffInstallment({ userId: user.id, subscriptionId: params.id, input: body }),
  }),
);

export const previewPlan = createController(
  z.object({ params: planParams, body: installmentPlanSchema }),
  async ({ user, params, body }) => ({
    data: await previewInstallmentPlan({ userId: user.id, subscriptionId: params.id, input: body }),
  }),
);
