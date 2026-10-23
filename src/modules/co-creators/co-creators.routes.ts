// src/modules/co-creators/co-creators.routes.ts
//
// REST endpoints for the per-key co-creator roster (#1139):
//
//   GET /keys/:key_id/co-creators           — active roster (wallet, role, added_at)
//   GET /keys/:key_id/co-creators/:wallet   — single co-creator detail with role
//
// Public, read-only. Mounted from keys.routes.ts via router.use('/', …).
// Both `:key_id` and `:keyId` spellings are accepted (whitelist module
// convention). Responses carry `Cache-Control: public, max-age=60` and are
// backed by a 60s Redis cache invalidated by the co-creator indexer.

import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { AsyncController } from '../../types/auth.types';
import {
   sendSuccess,
   sendValidationError,
   sendNotFound,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { cacheControl } from '../../middlewares/cache-control.middleware';
import { KEY_COCREATOR_CACHE_TTL_SECONDS } from '../../constants/redis.constants';
import {
   getCoCreatorDetail,
   listActiveCoCreators,
} from './co-creators.service';

const coCreatorsRouter = Router();

const normalizeKeyId = (req: Request, _res: Response, next: NextFunction) => {
   if (!req.params.keyId && req.params.key_id) {
      req.params.keyId = req.params.key_id;
   }
   next();
};

const WalletParamSchema = z
   .string()
   .min(1, 'Wallet address is required')
   .max(100, 'Invalid wallet address format')
   .regex(/^G[A-Za-z0-9]{30,70}$/, 'Invalid wallet address format');

const coCreatorCache = () =>
   cacheControl({
      maxAge: KEY_COCREATOR_CACHE_TTL_SECONDS,
      type: 'public',
      mustRevalidate: true,
   });

/**
 * GET /keys/:key_id/co-creators
 * Public. Active co-creator roster for a key: wallet, role, added_at.
 */
const httpListCoCreators: AsyncController = async (req, res, next) => {
   try {
      const keyId = (req.params.key_id ?? req.params.keyId) as string;
      if (!keyId) {
         return sendValidationError(res, 'Missing required parameters', [
            { field: 'keyId', message: 'Key ID is required' },
         ]);
      }
      return sendSuccess(res, await listActiveCoCreators(keyId));
   } catch (error) {
      next(error);
   }
};

/**
 * GET /keys/:key_id/co-creators/:wallet
 * Public. Detail for one co-creator of a key, including role and removal
 * state. 404 when the wallet was never a co-creator of the key.
 */
const httpGetCoCreator: AsyncController = async (req, res, next) => {
   try {
      const keyId = (req.params.key_id ?? req.params.keyId) as string;
      if (!keyId) {
         return sendValidationError(res, 'Missing required parameters', [
            { field: 'keyId', message: 'Key ID is required' },
         ]);
      }

      const parsedWallet = WalletParamSchema.safeParse(req.params.wallet);
      if (!parsedWallet.success) {
         return sendValidationError(
            res,
            'Invalid wallet address',
            zodIssuesToDetails(parsedWallet.error.issues)
         );
      }

      const detail = await getCoCreatorDetail(keyId, parsedWallet.data);
      if (!detail) {
         return sendNotFound(res, 'Co-creator');
      }
      return sendSuccess(res, detail);
   } catch (error) {
      next(error);
   }
};

coCreatorsRouter.get(
   ['/:key_id/co-creators', '/:keyId/co-creators'],
   normalizeKeyId,
   coCreatorCache(),
   httpListCoCreators
);

coCreatorsRouter.get(
   ['/:key_id/co-creators/:wallet', '/:keyId/co-creators/:wallet'],
   normalizeKeyId,
   coCreatorCache(),
   httpGetCoCreator
);

coCreatorsRouter.all(
   ['/:key_id/co-creators', '/:keyId/co-creators'],
   (_req, res) => {
      res.set('Allow', 'GET').sendStatus(405);
   }
);

export default coCreatorsRouter;
