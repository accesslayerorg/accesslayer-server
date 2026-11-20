// src/modules/content-access/content-access.routes.ts
//
// REST endpoint for the content-gate access check (#1137):
//
//   GET /keys/:key_id/content-access/:wallet
//
// Public, read-only. Contract-first (check_access simulation) with an
// off-chain fallback; responses carry `Cache-Control: public, max-age=30`
// and are backed by a 30s Redis cache invalidated on KEY_BOUGHT /
// KEY_SOLD. Both `:key_id` and `:keyId` spellings are accepted.

import { NextFunction, Request, Response, Router } from 'express';
import { AsyncController } from '../../types/auth.types';
import {
   sendSuccess,
   sendValidationError,
} from '../../utils/api-response.utils';
import { cacheControl } from '../../middlewares/cache-control.middleware';
import { CONTENT_ACCESS_CACHE_TTL_SECONDS } from '../../constants/redis.constants';
import { getContentAccess } from './content-access.service';

const contentAccessRouter = Router();

const normalizeKeyId = (req: Request, _res: Response, next: NextFunction) => {
   if (!req.params.keyId && req.params.key_id) {
      req.params.keyId = req.params.key_id;
   }
   next();
};

const WALLET_REGEX = /^G[A-Za-z0-9]{30,70}$/;

/**
 * GET /keys/:key_id/content-access/:wallet
 * Public. Returns { is_allowed, gate_type, requirement } for the wallet
 * on this key's content gate.
 */
const httpGetContentAccess: AsyncController = async (req, res, next) => {
   try {
      const keyId = (req.params.key_id ?? req.params.keyId) as string;
      const wallet = req.params.wallet as string;

      if (!keyId || !wallet) {
         return sendValidationError(res, 'Missing required parameters', [
            { field: 'keyId', message: 'Key ID is required' },
            { field: 'wallet', message: 'Wallet address is required' },
         ]);
      }

      if (!WALLET_REGEX.test(wallet)) {
         return sendValidationError(res, 'Invalid wallet address', [
            { field: 'wallet', message: 'Invalid Stellar wallet address' },
         ]);
      }

      return sendSuccess(res, await getContentAccess(keyId, wallet));
   } catch (error) {
      next(error);
   }
};

contentAccessRouter.get(
   ['/:key_id/content-access/:wallet', '/:keyId/content-access/:wallet'],
   normalizeKeyId,
   cacheControl({
      maxAge: CONTENT_ACCESS_CACHE_TTL_SECONDS,
      type: 'public',
      mustRevalidate: true,
   }),
   httpGetContentAccess
);

contentAccessRouter.all(
   ['/:key_id/content-access/:wallet', '/:keyId/content-access/:wallet'],
   (_req, res) => {
      res.set('Allow', 'GET').sendStatus(405);
   }
);

export default contentAccessRouter;
