// src/modules/reserves/reserves.routes.ts
//
// REST endpoint for the per-key reserve balance (#1140):
//
//   GET /keys/:key_id/reserve — reserve_balance, market_cap,
//       reserve_ratio_bps, low_reserve
//
// Public, read-only. Mounted from keys.routes.ts via router.use('/', …).
// Both `:key_id` and `:keyId` spellings are accepted (whitelist module
// convention). Responses carry `Cache-Control: public, max-age=60` and are
// backed by a 60s Redis cache invalidated by the reserve indexer.

import { NextFunction, Request, Response, Router } from 'express';
import { AsyncController } from '../../types/auth.types';
import {
   sendSuccess,
   sendValidationError,
} from '../../utils/api-response.utils';
import { cacheControl } from '../../middlewares/cache-control.middleware';
import { KEY_RESERVE_CACHE_TTL_SECONDS } from '../../constants/redis.constants';
import { getKeyReserve } from './reserves.service';

const reservesRouter = Router();

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

export default reservesRouter;
