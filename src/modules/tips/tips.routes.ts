// src/modules/tips/tips.routes.ts
//
// REST endpoints for per-key tip history (#1132):
//
//   GET /keys/:key_id/tips                     — paginated tip history
//   GET /keys/:key_id/tips/total               — cumulative tip totals
//   GET /keys/:key_id/tips/:tipId/content      — IPFS message content
//
// Public, read-only. Mounted from keys.routes.ts via router.use('/', …).
// Both `:key_id` and `:keyId` spellings are accepted (whitelist module
// convention). List/total carry `Cache-Control: public, max-age=60` and
// are backed by a 60s Redis cache invalidated by the tip indexer.

import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { AsyncController } from '../../types/auth.types';
import {
   sendSuccess,
   sendValidationError,
   sendNotFound,
   sendError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import { cacheControl } from '../../middlewares/cache-control.middleware';
import { KEY_TIPS_CACHE_TTL_SECONDS } from '../../constants/redis.constants';
import {
   getTipMessageContent,
   getTipTotals,
   listTips,
} from './tips.service';

const tipsRouter = Router();

const normalizeKeyId = (req: Request, _res: Response, next: NextFunction) => {
   if (!req.params.keyId && req.params.key_id) {
      req.params.keyId = req.params.key_id;
   }
   next();
};

const ListTipsQuerySchema = z.object({
   limit: z.coerce.number().int().min(1).max(100).default(20),
   cursor: z.string().min(1).optional(),
});

const tipsCache = () =>
   cacheControl({
      maxAge: KEY_TIPS_CACHE_TTL_SECONDS,
      type: 'public',
      mustRevalidate: true,
   });

/**
 * GET /keys/:key_id/tips?limit=&cursor=
 * Public. Cursor-paginated tip history: tipper, amount, message_hash,
 * tipped_at.
 */
const httpListTips: AsyncController = async (req, res, next) => {
   try {
      const keyId = (req.params.key_id ?? req.params.keyId) as string;
      if (!keyId) {
         return sendValidationError(res, 'Missing required parameters', [
            { field: 'keyId', message: 'Key ID is required' },
         ]);
      }

      const parsedQuery = ListTipsQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
         return sendValidationError(
            res,
            'Invalid tips query',
            zodIssuesToDetails(parsedQuery.error.issues)
         );
      }

      return sendSuccess(
         res,
         await listTips(
            keyId,
            parsedQuery.data.limit,
            parsedQuery.data.cursor
         )
      );
   } catch (error) {
      next(error);
   }
};

/**
 * GET /keys/:key_id/tips/total
 * Public. Cumulative tips received by the key. Zero when none.
 */
const httpGetTipTotals: AsyncController = async (req, res, next) => {
   try {
      const keyId = (req.params.key_id ?? req.params.keyId) as string;
      if (!keyId) {
         return sendValidationError(res, 'Missing required parameters', [
            { field: 'keyId', message: 'Key ID is required' },
         ]);
      }
      return sendSuccess(res, await getTipTotals(keyId));
   } catch (error) {
      next(error);
   }
};

/**
 * GET /keys/:key_id/tips/:tipId/content
 * Public. IPFS message content for a tip, fetched on demand and cached.
 */
const httpGetTipContent: AsyncController = async (req, res) => {
   try {
      const keyId = (req.params.key_id ?? req.params.keyId) as string;
      if (!keyId) {
         return sendValidationError(res, 'Missing required parameters', [
            { field: 'keyId', message: 'Key ID is required' },
         ]);
      }

      const tipId = String(req.params.tipId ?? '');
      const content = await getTipMessageContent(keyId, tipId);
      if (!content) {
         return sendNotFound(res, 'Tip message');
      }
      return sendSuccess(res, content);
   } catch {
      // Gateway failures surface as 502 rather than a generic 500.
      return sendError(
         res,
         502,
         ErrorCode.SERVICE_UNAVAILABLE,
         'Failed to fetch tip message content from IPFS gateway'
      );
   }
};

tipsRouter.get(
   ['/:key_id/tips/total', '/:keyId/tips/total'],
   normalizeKeyId,
   tipsCache(),
   httpGetTipTotals
);

tipsRouter.get(
   ['/:key_id/tips', '/:keyId/tips'],
   normalizeKeyId,
   tipsCache(),
   httpListTips
);

tipsRouter.get(
   ['/:key_id/tips/:tipId/content', '/:keyId/tips/:tipId/content'],
   normalizeKeyId,
   tipsCache(),
   httpGetTipContent
);

tipsRouter.all(['/:key_id/tips', '/:keyId/tips'], (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

export default tipsRouter;
