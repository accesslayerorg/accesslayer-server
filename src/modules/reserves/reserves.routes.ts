// src/modules/reserves/reserves.routes.ts
//
// REST endpoint for the per-key reserve balance (#1140):
//
//   GET /keys/:key_id/reserve — reserve_balance, market_cap,
//       reserve_ratio_bps, low_reserve
//   GET /keys/:key_id/reserve/history — paginated ReserveAccrued /
//       ReserveDeployed event log, newest first (#1157)
//
// Public, read-only. Mounted from keys.routes.ts via router.use('/', …).
// Both `:key_id` and `:keyId` spellings are accepted (whitelist module
// convention). Responses carry `Cache-Control: public, max-age=60` and are
// backed by a 60s Redis cache invalidated by the reserve indexer.

import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { AsyncController } from '../../types/auth.types';
import {
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { cacheControl } from '../../middlewares/cache-control.middleware';
import { KEY_RESERVE_CACHE_TTL_SECONDS } from '../../constants/redis.constants';
import { getKeyReserve, getKeyReserveHistory } from './reserves.service';

const reservesRouter = Router();

const historyQuerySchema = z.object({
   limit: z.coerce.number().int().min(1).max(100).default(50),
   offset: z.coerce.number().int().min(0).default(0),
});

const normalizeKeyId = (req: Request, _res: Response, next: NextFunction) => {
   if (!req.params.keyId && req.params.key_id) {
      req.params.keyId = req.params.key_id;
   }
   next();
};

/**
 * GET /keys/:key_id/reserve
 * Public. Current reserve balance, market cap, ratio and low-reserve flag
 * for a key. Keys with no reserve accrued report a zero balance.
 */
const httpGetKeyReserve: AsyncController = async (req, res, next) => {
   try {
      const keyId = (req.params.key_id ?? req.params.keyId) as string;
      if (!keyId) {
         return sendValidationError(res, 'Missing required parameters', [
            { field: 'keyId', message: 'Key ID is required' },
         ]);
      }
      return sendSuccess(res, await getKeyReserve(keyId));
   } catch (error) {
      next(error);
   }
};

reservesRouter.get(
   ['/:key_id/reserve', '/:keyId/reserve'],
   normalizeKeyId,
   cacheControl({
      maxAge: KEY_RESERVE_CACHE_TTL_SECONDS,
      type: 'public',
      mustRevalidate: true,
   }),
   httpGetKeyReserve
);

reservesRouter.all(['/:key_id/reserve', '/:keyId/reserve'], (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

/**
 * GET /keys/:key_id/reserve/history?limit=&offset=
 * Public. Paginated reserve event history for a key, newest first.
 */
const httpGetKeyReserveHistory: AsyncController = async (req, res, next) => {
   try {
      const keyId = (req.params.key_id ?? req.params.keyId) as string;
      if (!keyId) {
         return sendValidationError(res, 'Missing required parameters', [
            { field: 'keyId', message: 'Key ID is required' },
         ]);
      }
      const parsed = historyQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         return sendValidationError(
            res,
            'Invalid pagination parameters',
            zodIssuesToDetails(parsed.error.issues)
         );
      }
      return sendSuccess(
         res,
         await getKeyReserveHistory(keyId, parsed.data.limit, parsed.data.offset)
      );
   } catch (error) {
      next(error);
   }
};

reservesRouter.get(
   ['/:key_id/reserve/history', '/:keyId/reserve/history'],
   normalizeKeyId,
   cacheControl({
      maxAge: KEY_RESERVE_CACHE_TTL_SECONDS,
      type: 'public',
      mustRevalidate: true,
   }),
   httpGetKeyReserveHistory
);

reservesRouter.all(
   ['/:key_id/reserve/history', '/:keyId/reserve/history'],
   (_req, res) => {
      res.set('Allow', 'GET').sendStatus(405);
   }
);

export default reservesRouter;
