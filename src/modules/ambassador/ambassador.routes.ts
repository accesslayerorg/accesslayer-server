import { Router, Request, Response, NextFunction } from 'express';
import {
   AuthenticatedRequest,
   requireJwtAuth,
} from '../../middlewares/jwt-auth.middleware';
import {
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { CursorChecksumError } from '../../utils/cursor.utils';
import {
   ambassadorPayoutsQuerySchema,
   ambassadorStatsQuerySchema,
   recordClickSchema,
} from './ambassador.schemas';
import {
   AmbassadorService,
   ReferralCodeNotFoundError,
} from './ambassador.service';

export const referralClickRouter = Router();
export const ambassadorRouter = Router();

/**
 * POST /v1/referrals/click
 * Record a referral link click with UTM fields and first-party cookie id.
 */
referralClickRouter.post(
   '/click',
   async (req: Request, res: Response, next: NextFunction) => {
      const parsed = recordClickSchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid referral click payload',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      try {
         const click = await AmbassadorService.recordClick(parsed.data);
         sendSuccess(res, click, 201);
      } catch (error) {
         if (error instanceof ReferralCodeNotFoundError) {
            sendNotFound(res, 'Referral code');
            return;
         }
         next(error);
      }
   }
);

/**
 * GET /v1/ambassador/stats?range=
 * Return referral funnel stats, tier, and accrued earnings for the authenticated wallet.
 */
ambassadorRouter.get(
   '/stats',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      const parsed = ambassadorStatsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid stats query',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      try {
         const stats = await AmbassadorService.stats(
            req.user!.wallet,
            parsed.data.range
         );
         sendSuccess(res, stats, 200);
      } catch (error) {
         next(error);
      }
   }
);

/**
 * GET /v1/ambassador/payouts?cursor=
 * Return cursor-paginated daily payout accruals for the authenticated wallet.
 */
ambassadorRouter.get(
   '/payouts',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      const parsed = ambassadorPayoutsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid payouts query',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      try {
         const payouts = await AmbassadorService.listPayouts(
            req.user!.wallet,
            parsed.data
         );
         sendSuccess(res, payouts, 200);
      } catch (error) {
         if (error instanceof CursorChecksumError) {
            sendValidationError(res, error.message);
            return;
         }
         next(error);
      }
   }
);
