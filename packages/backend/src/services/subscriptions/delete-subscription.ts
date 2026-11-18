import { withTransaction } from '@services/common/with-transaction';

import { findSubscriptionOrThrow } from './helpers';
import { assertNoInstallmentPlan } from './installment-plan/guards';

export const deleteSubscription = withTransaction(async ({ id, userId }: { id: string; userId: number }) => {
  const subscription = await findSubscriptionOrThrow({ id, userId, lock: true });
  await assertNoInstallmentPlan(id);

  await subscription.destroy();

  return { success: true };
});
