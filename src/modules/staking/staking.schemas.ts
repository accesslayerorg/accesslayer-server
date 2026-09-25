// src/modules/staking/staking.schemas.ts
import { z } from 'zod';

export const VALID_LOCK_PERIODS = [7, 30, 90, 180] as const;

export const stakeBodySchema = z.object({
   keyId: z.string().min(1, 'keyId is required'),
   amount: z
      .number({ required_error: 'amount is required' })
      .positive('amount must be positive'),
   lockPeriodDays: z
      .number({ required_error: 'lockPeriodDays is required' })
      .int('lockPeriodDays must be an integer')
      .refine(
         (val): val is (typeof VALID_LOCK_PERIODS)[number] =>
            VALID_LOCK_PERIODS.includes(val as any),
         {
            message: `lockPeriodDays must be one of: ${VALID_LOCK_PERIODS.join(', ')}`,
         }
      ),
});

export const unstakeBodySchema = z.object({
   keyId: z.string().min(1, 'keyId is required'),
   amount: z
      .number({ required_error: 'amount is required' })
      .positive('amount must be positive'),
});

export type StakeInput = z.infer<typeof stakeBodySchema>;
export type UnstakeInput = z.infer<typeof unstakeBodySchema>;
