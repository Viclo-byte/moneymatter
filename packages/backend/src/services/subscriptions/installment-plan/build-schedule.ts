import type {
  InstallmentPlanInput,
  InstallmentAmounts,
  InstallmentScheduleInput,
  SubscriptionRecurrence,
} from '@bt/shared/types';
import { Money } from '@common/types/money';
import { ValidationError } from '@js/errors';

import { calculateNextDueDate } from '../calculate-next-due-date';

export function validateAmounts(value: InstallmentAmounts): void {
  if (
    !Money.fromDecimal(value.principal).add(Money.fromDecimal(value.interest)).equals(Money.fromDecimal(value.total))
  ) {
    throw new ValidationError({ message: 'Principal plus interest must equal the payment total.' });
  }
}

/** Pure expansion, including month-end anchoring and an exact final principal residual. */
export function buildInstallmentSchedule(
  input: InstallmentPlanInput,
  subscription: SubscriptionRecurrence & { maxOccurrences: number; dueDate: string; anchorDay: number | null },
) {
  const count = subscription.maxOccurrences;
  if (count < 1 || count > 600)
    throw new ValidationError({ message: 'An installment plan supports 1 to 600 payments.' });
  if (input.mode === 'custom' && input.schedule?.length !== count)
    throw new ValidationError({ message: 'Provide every installment in custom mode.' });
  validateAmounts(input.regular);
  if (input.first) validateAmounts(input.first);
  if (count === 1 && input.mode === 'fixed' && input.first) {
    if (
      !Money.fromDecimal(input.first.principal).equals(Money.fromDecimal(input.totalPrincipal)) ||
      (input.last && !Money.fromDecimal(input.last.interest).equals(Money.fromDecimal(input.first.interest)))
    )
      throw new ValidationError({ message: 'A single-payment plan must use consistent first and final amounts.' });
  }
  let dueDate = subscription.dueDate;
  let allocated = Money.zero();
  const items = Array.from({ length: count }, (_, index) => {
    let value: InstallmentScheduleInput =
      input.mode === 'custom' ? input.schedule![index]! : index === 0 && input.first ? input.first : input.regular;
    if (input.mode === 'fixed' && index === count - 1) {
      const principal = Money.fromDecimal(input.totalPrincipal).subtract(allocated);
      if (principal.isNegative())
        throw new ValidationError({ message: 'Scheduled principal exceeds the total principal.' });
      const interest = Money.fromDecimal(input.last?.interest ?? value.interest);
      if (input.last?.principal !== undefined && !principal.equals(Money.fromDecimal(input.last.principal)))
        throw new ValidationError({ message: 'Final principal must equal the remaining principal.' });
      if (input.last?.total !== undefined && !principal.add(interest).equals(Money.fromDecimal(input.last.total)))
        throw new ValidationError({ message: 'Final payment does not match principal plus interest.' });
      value = {
        principal: principal.toNumber(),
        interest: interest.toNumber(),
        total: principal.add(interest).toNumber(),
        dueDate: input.last?.dueDate ?? value.dueDate,
      };
    }
    validateAmounts(value);
    if (value.total <= 0) throw new ValidationError({ message: 'Each installment must have a positive total.' });
    dueDate = value.dueDate ?? dueDate;
    const item = {
      occurrenceNumber: index + 1,
      dueDate,
      principal: Money.fromDecimal(value.principal),
      interest: Money.fromDecimal(value.interest),
      total: Money.fromDecimal(value.total),
    };
    allocated = allocated.add(item.principal);
    dueDate = calculateNextDueDate({
      ...subscription,
      currentDueDate: dueDate,
      anchorDay: subscription.anchorDay ?? Number(subscription.dueDate.slice(8, 10)),
    });
    return item;
  });
  if (!allocated.equals(Money.fromDecimal(input.totalPrincipal)))
    throw new ValidationError({ message: 'Scheduled principal must equal total principal.' });
  for (let i = 1; i < items.length; i++)
    if (items[i]!.dueDate <= items[i - 1]!.dueDate)
      throw new ValidationError({ message: 'Installment dates must increase in payment order.' });
  return items;
}
