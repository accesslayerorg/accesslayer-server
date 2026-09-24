import { Router } from 'express';
import { httpListCreators, httpGetCreatorStats } from '../creators/creators.controllers';
import { cacheControl } from '../../middlewares/cache-control.middleware';
import { CREATOR_PUBLIC_ROUTE_CACHE_PRESETS } from '../../constants/creator-public-cache.constants';
import { CREATOR_PUBLIC_ROUTE_NAMES } from '../../constants/creator-public-routes.constants';
import { createCreatorReadMetricsMiddleware } from '../../utils/creator-read-metrics.utils';
import { normalizeTrailingSlash } from '../../middlewares/trailing-slash-normalizer.middleware';
import { requireKeyCreator, AuthenticatedRequest } from '../../middlewares/jwt-auth.middleware';
import { sendError, sendSuccess } from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import { prisma } from '../../utils/prisma.utils';
import { buyGateway } from './buy.service';
import { horizonRequest } from '../../utils/horizon-api.utils';
import { getRedisClient } from '../../utils/redis.utils';
import { deprecateGateway } from './creator-deprecate.service';

const creatorsRouter = Router();

// Normalize trailing slashes for all creator routes so that, e.g.,
// GET /api/v1/creators/ reaches the same handler as GET /api/v1/creators.
// Scoped to this router to avoid side-effects on other route groups.
creatorsRouter.use(normalizeTrailingSlash);

/**
 * GET /api/v1/creators
 *
 * List all creators with pagination and filtering.
 * Public endpoint with 5-minute cache.
 */
creatorsRouter.get(
   '/',
   createCreatorReadMetricsMiddleware('list'),
   cacheControl(CREATOR_PUBLIC_ROUTE_CACHE_PRESETS[CREATOR_PUBLIC_ROUTE_NAMES.LIST]),
   httpListCreators
);
// 405 handler for /
creatorsRouter.all('/', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

/**
 * GET /api/v1/creators/:id/stats
 *
 * Get public stats for a specific creator.
 * Public endpoint with 5-minute cache.
 */
creatorsRouter.get(
   '/:id/stats',
   createCreatorReadMetricsMiddleware('detail'),
   cacheControl(CREATOR_PUBLIC_ROUTE_CACHE_PRESETS[CREATOR_PUBLIC_ROUTE_NAMES.GET_STATS]),
   httpGetCreatorStats
);
// 405 handler for /:id/stats
creatorsRouter.all('/:id/stats', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

/**
 * POST /api/v1/creator/:keyId/holder-cap
 * Update holder cap endpoint for creators to change max keys a single wallet can hold (#841).
 */
creatorsRouter.post(
   '/:keyId/holder-cap',
   requireKeyCreator('keyId'),
   async (req: AuthenticatedRequest, res, next) => {
      const { capBps } = req.body || {};
      if (
         capBps === undefined ||
         capBps === null ||
         typeof capBps !== 'number' ||
         capBps < 100 ||
         capBps > 2500
      ) {
         sendError(
            res,
            422,
            ErrorCode.UNPROCESSABLE_ENTITY,
            'capBps must be between 100 and 2500'
         );
         return;
      }

      const keyId = Array.isArray(req.params.keyId)
         ? req.params.keyId[0]
         : req.params.keyId;
      try {
         const creatorProfile = await prisma.creatorProfile.findFirst({
            where: { OR: [{ id: keyId }, { handle: keyId }] },
         });
         if (!creatorProfile) {
            sendError(res, 404, ErrorCode.NOT_FOUND, 'Key not found');
            return;
         }

         const updated = await prisma.creatorProfile.update({
            where: { id: creatorProfile.id },
            data: { holderCapBps: capBps },
         });

         sendSuccess(res, {
            holderCapBps: updated.holderCapBps,
            percentage: `${updated.holderCapBps / 100}%`,
         });
      } catch (error) {
         next(error);
      }
   }
 );

/**
 * POST /api/v1/creator/:keyId/deprecate
 * Initiate a buyback wind-down and deprecate a creator key (#872).
 */
creatorsRouter.post(
   '/:keyId/deprecate',
   requireKeyCreator('keyId'),
   async (req: AuthenticatedRequest, res, next) => {
      const keyId = Array.isArray(req.params.keyId)
         ? req.params.keyId[0]
         : req.params.keyId;

      const { buybackPricePerKey } = req.body || {};

      if (buybackPricePerKey === 0) {
         sendError(
            res,
            422,
            ErrorCode.UNPROCESSABLE_ENTITY,
            'buybackPricePerKey must be greater than zero'
         );
         return;
      }

      if (
         typeof buybackPricePerKey !== 'number' ||
         isNaN(buybackPricePerKey) ||
         !Number.isInteger(buybackPricePerKey) ||
         buybackPricePerKey < 1
      ) {
         sendError(
            res,
            422,
            ErrorCode.UNPROCESSABLE_ENTITY,
            'buybackPricePerKey must be a positive integer'
         );
         return;
      }

      try {
         const creatorProfile = await prisma.creatorProfile.findFirst({
            where: { OR: [{ id: keyId }, { handle: keyId }] },
         });
         if (!creatorProfile) {
            sendError(res, 404, ErrorCode.NOT_FOUND, 'Key not found');
            return;
         }

         const circulatingSupply = Number(creatorProfile.circulatingSupply);
         const requiredXlm = circulatingSupply * buybackPricePerKey;

         // Check creator wallet balance
         const walletAddress = req.user!.wallet;
         let creatorBalance = 0;
         try {
            creatorBalance = await buyGateway.getXlmBalance(walletAddress);
         } catch {
            try {
               const resHorizon = await horizonRequest(`/accounts/${walletAddress}`);
               if (resHorizon.ok) {
                  const data = (await resHorizon.json()) as {
                     balances?: Array<{ asset_type: string; balance: string }>;
                  };
                  const native = data.balances?.find(b => b.asset_type === 'native');
                  creatorBalance = native ? parseFloat(native.balance) : 0;
               }
            } catch {
               creatorBalance = 0;
            }
         }

         if (creatorBalance < requiredXlm) {
            sendError(
               res,
               400,
               ErrorCode.INSUFFICIENT_BALANCE,
               'Insufficient creator XLM balance to cover key buyback'
            );
            return;
         }

         // Submit deprecate_key contract call
         await deprecateGateway.deprecateKey({
            creatorId: creatorProfile.id,
            buybackPricePerKey,
            circulatingSupply,
         });

         // Update key status to Deprecated in database
         const updated = await prisma.creatorProfile.update({
            where: { id: creatorProfile.id },
            data: {
               status: 'Deprecated',
               tradingPaused: true,
            },
         });

         // Record activity
         await prisma.activity.create({
            data: {
               type: 'KEY_DEPRECATED',
               actor: walletAddress,
               creatorId: creatorProfile.id,
               payload: {
                  keyId: creatorProfile.id,
                  buybackPricePerKey,
                  circulatingSupply,
                  notification: 'key_deprecated',
               },
            },
         });

         // Notify all current holders via the notification queue
         const holders = await prisma.keyOwnership.findMany({
            where: {
               creatorId: creatorProfile.id,
               balance: { gt: 0 },
            },
            select: { ownerAddress: true, balance: true },
         });

         const redis = getRedisClient();
         for (const holder of holders) {
            if (redis) {
               await redis.lpush(
                  'queue:notifications',
                  JSON.stringify({
                     type: 'key_deprecated',
                     keyId: creatorProfile.id,
                     walletAddress: holder.ownerAddress,
                     buybackPricePerKey,
                     balance: holder.balance.toString(),
                     timestamp: new Date().toISOString(),
                  })
               );
            }
         }

         sendSuccess(res, {
            keyId: creatorProfile.id,
            status: updated.status,
            buybackPricePerKey,
            circulatingSupply,
            notifiedHoldersCount: holders.length,
         });
      } catch (error) {
         next(error);
      }
   }
);

export default creatorsRouter;