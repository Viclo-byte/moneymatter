import { ValidationError } from '@js/errors';
import Plans from '@models/installment-plans.model';
import Settlements from '@models/installment-settlements.model';
import Subscriptions from '@models/subscriptions.model';
import { Op } from 'sequelize';

export async function assertNoInstallmentPlan(subscriptionId: string) {
  if (await Plans.count({ where: { subscriptionId } }))
    throw new ValidationError({
      message: 'Use the installment plan to edit its schedule or revert its complete settlement.',
    });
}

export async function assertInstallmentTransactionWritable(id: string, ownerUserId: number) {
  const references = await Settlements.findAll({
    where: { state: { [Op.in]: ['settled', 'reverted'] }, transactionIds: { [Op.contains]: [id] } },
    attributes: ['planId'],
  });
  if (!references.length) return;
  const plans = await Plans.findAll({
    where: { id: { [Op.in]: references.map((row) => row.planId) } },
    attributes: ['subscriptionId'],
  });
  if (
    await Subscriptions.count({
      where: { id: { [Op.in]: plans.map((plan) => plan.subscriptionId) }, userId: ownerUserId },
    })
  )
    throw new ValidationError({
      message:
        'Use the installment period to revert this complete settlement; individual transaction edits are not allowed.',
    });
}
