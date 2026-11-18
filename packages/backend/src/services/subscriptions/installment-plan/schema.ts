import { recordId, dateBound } from '@common/lib/zod/custom-types';
import { z } from 'zod';

// Cents must be representable exactly in the project's BIGINT -> Number boundary.
const amount = z.number().finite().nonnegative().max(1_000_000_000).multipleOf(0.01);
const amounts = z.object({ principal: amount, interest: amount, total: amount });
export const installmentPlanSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    totalPrincipal: amount.positive(),
    mode: z.enum(['fixed', 'custom']),
    regular: amounts,
    first: amounts.extend({ dueDate: dateBound().optional() }).optional(),
    last: z
      .object({
        principal: amount.optional(),
        interest: amount,
        total: amount.optional(),
        dueDate: dateBound().optional(),
      })
      .optional(),
    schedule: z
      .array(amounts.extend({ dueDate: dateBound().optional() }))
      .min(1)
      .max(600)
      .optional(),
    sourceAccountId: recordId().optional(),
    linkedSettlementEnabled: z.boolean(),
    destinationAccountId: recordId().nullable().optional(),
    interestCategoryId: recordId().nullable().optional(),
  })
  .strict();

export const installmentItemSchema = amounts
  .extend({
    revision: z.number().int().positive(),
    dueDate: dateBound(),
  })
  .strict();

export const installmentPayoffSchema = z
  .object({
    revision: z.number().int().positive(),
    generation: z.number().int().nonnegative(),
    principal: amount.positive(),
    interest: amount,
    time: z.coerce.date().optional(),
  })
  .strict();
