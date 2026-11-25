import { z } from 'zod';
import { safeIntParam } from '../../utils/query.utils';
import {
   MAX_PAGE_SIZE,
   MIN_PAGE_SIZE,
} from '../../constants/pagination.constants';
import { DEFAULT_REFERRAL_HOLD_PAGE_SIZE } from '../referrals/referral-hold.service';

/** GET /admin/referral-holds query. */
export const ReferralHoldsQuerySchema = z.object({
   status: z.enum(['PENDING', 'RELEASED', 'REJECTED']).optional(),
   limit: safeIntParam({
      defaultValue: DEFAULT_REFERRAL_HOLD_PAGE_SIZE,
      min: MIN_PAGE_SIZE,
      max: MAX_PAGE_SIZE,
      label: 'Limit',
   }),
   cursor: z.string().optional(),
});

/** PATCH /admin/referral-holds/:id params. */
export const ReferralHoldParamsSchema = z.object({
   id: z.string().trim().min(1, 'Hold id is required').max(64),
});

/** PATCH /admin/referral-holds/:id body: release pays, reject never pays. */
export const ResolveReferralHoldSchema = z
   .object({
      status: z.enum(['RELEASED', 'REJECTED'], {
         errorMap: () => ({
            message: 'status must be RELEASED or REJECTED',
         }),
      }),
   })
   .strict();
