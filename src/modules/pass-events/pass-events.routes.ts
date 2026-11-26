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
import { CursorChecksumError } from '../../utils/cursor.utils';
import {
   AuthenticatedRequest,
   requireJwtAuth,
} from '../../middlewares/jwt-auth.middleware';
import {
   PassEventForbiddenError,
   PassEventNotFoundError,
   PassEventsService,
} from './pass-events.service';

export const keyPassEventsRouter = Router();
export const passEventsRouter = Router();

const keyParamsSchema = z.object({
   keyId: z.string().trim().min(1).max(256),
});

const eventParamsSchema = z.object({
   id: z.string().trim().min(1).max(256),
});

const eligibilityQuerySchema = z.object({
   wallet: z.string().trim().min(1).max(128),
});

const redemptionsQuerySchema = z.object({
   cursor: z.string().min(1).optional(),
   limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * GET /v1/keys/:keyId/events
 * Lists event passes for a key with window, capacity, redeemed count and status.
 */
keyPassEventsRouter.get('/:keyId/events', async (req, res, next) => {
   const params = keyParamsSchema.safeParse(req.params);
   if (!params.success) {
      sendValidationError(
         res,
         'Invalid key identifier',
         zodIssuesToDetails(params.error.issues)
      );
      return;
   }

   try {
      const result = await PassEventsService.listKeyEvents(params.data.keyId);
      sendSuccess(res, result, 200, 'Key events retrieved');
   } catch (error) {
      next(error);
   }
});

/**
 * GET /v1/events/:id/eligibility?wallet=
 * Checks whether a wallet is eligible to redeem an event pass.
 */
passEventsRouter.get('/:id/eligibility', async (req, res, next) => {
   const params = eventParamsSchema.safeParse(req.params);
   if (!params.success) {
      sendValidationError(
         res,
         'Invalid event identifier',
         zodIssuesToDetails(params.error.issues)
      );
      return;
   }

   const query = eligibilityQuerySchema.safeParse(req.query);
   if (!query.success) {
      sendValidationError(
         res,
         'Invalid wallet query parameter',
         zodIssuesToDetails(query.error.issues)
      );
      return;
   }

   try {
      const result = await PassEventsService.checkEligibility(
         params.data.id,
         query.data.wallet
      );
      sendSuccess(res, result, 200, 'Eligibility checked');
   } catch (error) {
      if (error instanceof PassEventNotFoundError) {
         sendNotFound(res, 'Event');
         return;
      }
      next(error);
   }
});

/**
 * GET /v1/events/:id/redemptions?cursor=
 * Lists redemptions for the event creator with cursor pagination.
 */
passEventsRouter.get(
   '/:id/redemptions',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res, next) => {
      const params = eventParamsSchema.safeParse(req.params);
      if (!params.success) {
         sendValidationError(
            res,
            'Invalid event identifier',
            zodIssuesToDetails(params.error.issues)
         );
         return;
      }

      const query = redemptionsQuerySchema.safeParse(req.query);
      if (!query.success) {
         sendValidationError(
            res,
            'Invalid query parameters',
            zodIssuesToDetails(query.error.issues)
         );
         return;
      }

      try {
         const result = await PassEventsService.listRedemptions(
            params.data.id,
            req.user!.wallet,
            query.data.cursor,
            query.data.limit
         );
         sendSuccess(res, result, 200, 'Redemptions retrieved');
      } catch (error) {
         if (error instanceof PassEventNotFoundError) {
            sendNotFound(res, 'Event');
            return;
         }
         if (error instanceof PassEventForbiddenError) {
            sendError(res, 403, ErrorCode.FORBIDDEN, error.message);
            return;
         }
         if (error instanceof CursorChecksumError) {
            sendValidationError(res, 'Invalid cursor');
            return;
         }
         next(error);
      }
   }
);
