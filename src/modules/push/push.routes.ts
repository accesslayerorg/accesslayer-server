import { Router } from 'express';
import { z } from 'zod';
import { ErrorCode } from '../../constants/error.constants';
import {
   sendError,
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   AuthenticatedRequest,
   requireJwtAuth,
} from '../../middlewares/jwt-auth.middleware';
import { PUSH_EVENTS } from './push-events.utils';
import { getVapidConfig, PushService } from './push.service';

const subscribeSchema = z
   .object({
      endpoint: z.string().url(),
      keys: z
         .object({
            p256dh: z.string().min(1),
            auth: z.string().min(1),
         })
         .strict(),
      events: z.array(z.enum(PUSH_EVENTS)).min(1),
   })
   .strict();

const unsubscribeSchema = z
   .object({
      endpoint: z.string().url(),
   })
   .strict();

const router = Router();

/**
 * GET /v1/push/vapid-public-key
 * Returns the VAPID public key for browser push subscription registration.
 */
router.get('/vapid-public-key', (_req, res) => {
   const vapid = getVapidConfig();
   if (!vapid) {
      sendError(
         res,
         503,
         ErrorCode.INTERNAL_ERROR,
         'VAPID public key is not configured'
      );
      return;
   }
   sendSuccess(
      res,
      { publicKey: vapid.publicKey },
      200,
      'VAPID public key retrieved'
   );
});

/**
 * POST /v1/push/subscribe
 * Registers or updates a push subscription for the authenticated wallet.
 */
router.post(
   '/subscribe',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res, next) => {
      const parsed = subscribeSchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid push subscription payload',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      try {
         const subscription = await PushService.subscribe(
            req.user!.wallet,
            parsed.data
         );
         sendSuccess(res, { subscription }, 201, 'Push subscription saved');
      } catch (error) {
         next(error);
      }
   }
);

/**
 * DELETE /v1/push/subscribe
 * Removes a push subscription for the authenticated wallet.
 */
router.delete(
   '/subscribe',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res, next) => {
      const candidate =
         req.body && Object.keys(req.body).length > 0 ? req.body : req.query;
      const parsed = unsubscribeSchema.safeParse(candidate);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid unsubscribe payload',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      try {
         const deleted = await PushService.unsubscribe(
            req.user!.wallet,
            parsed.data.endpoint
         );
         if (!deleted) {
            sendNotFound(res, 'Push subscription');
            return;
         }
         sendSuccess(res, { deleted: true }, 200, 'Push subscription removed');
      } catch (error) {
         next(error);
      }
   }
);

export default router;
