// Admin endpoints for referral rewards withheld by abuse detection (#1241):
//   GET   /api/v1/admin/referral-holds
//   PATCH /api/v1/admin/referral-holds/:id

import { NextFunction, Response } from 'express';
import { AdminRequest } from '../../middlewares/admin-guard.middleware';
import {
   sendConflict,
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { CursorChecksumError } from '../../utils/cursor.utils';
import {
   listReferralHolds,
   ReferralHoldAlreadyResolvedError,
   ReferralHoldNotFoundError,
   resolveReferralHold,
} from '../referrals/referral-hold.service';
import { createAuditEntry } from './audit-log.service';
import {
   ReferralHoldParamsSchema,
   ReferralHoldsQuerySchema,
   ResolveReferralHoldSchema,
} from './referral-holds.schemas';

export async function httpListReferralHolds(
   req: AdminRequest,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const parsed = ReferralHoldsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid query parameters',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      sendSuccess(res, await listReferralHolds(parsed.data));
   } catch (error) {
      if (error instanceof CursorChecksumError) {
         sendValidationError(res, 'Invalid cursor', [
            { field: 'cursor', message: error.message },
         ]);
         return;
      }
      next(error);
   }
}

export async function httpResolveReferralHold(
   req: AdminRequest,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const params = ReferralHoldParamsSchema.safeParse(req.params);
      if (!params.success) {
         sendValidationError(
            res,
            'Invalid hold id',
            zodIssuesToDetails(params.error.issues)
         );
         return;
      }
      const body = ResolveReferralHoldSchema.safeParse(req.body);
      if (!body.success) {
         sendValidationError(
            res,
            'Invalid request body',
            zodIssuesToDetails(body.error.issues)
         );
         return;
      }

      const adminId = req.adminId!;
      const hold = await resolveReferralHold(
         params.data.id,
         body.data.status,
         adminId
      );

      await createAuditEntry({
         actorWallet: adminId,
         actionType:
            body.data.status === 'RELEASED'
               ? 'referral_hold_released'
               : 'referral_hold_rejected',
         targetId: hold.id,
         payload: {
            referralId: hold.referralId,
            reason: hold.reason,
            rewardXlm: hold.rewardXlm,
            withheldTrades: hold.withheldTrades,
         },
      });

      sendSuccess(res, hold);
   } catch (error) {
      if (error instanceof ReferralHoldNotFoundError) {
         sendNotFound(res, 'Referral hold');
         return;
      }
      if (error instanceof ReferralHoldAlreadyResolvedError) {
         sendConflict(res, error.message);
         return;
      }
      next(error);
   }
}
