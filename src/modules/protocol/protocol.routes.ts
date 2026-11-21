import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';
import {
   sendSuccess,
   sendError,
   sendValidationError,
   ErrorCode,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { requireJwtAuth } from '../../middlewares/jwt-auth.middleware';
import {
   adminGuard,
   AdminRequest,
} from '../../middlewares/admin-guard.middleware';
import {
   getCurrentFeeTier,
   updateFeeTierConfig,
   loadFeeTierConfig,
} from './fee-tier.service';
import { logger } from '../../utils/logger.utils';

const router = Router();

const updateFeeTierBodySchema = z.object({
   tiers: z
      .array(
         z.object({
            volumeThreshold: z
               .number()
               .nonnegative('volumeThreshold must be non-negative'),
            feeBps: z
               .number()
               .int()
               .min(1, 'feeBps must be at least 1')
               .max(10000, 'feeBps must not exceed 10000'),
            label: z.string().optional(),
         })
      )
      .min(1, 'At least one tier is required'),
});

const PROTOCOL_STATUS_CACHE_KEY = 'protocol:status';
const PROTOCOL_STATUS_CACHE_TTL = 30;

interface OnChainProtocolStatus {
   globalTradingPaused: boolean;
   protocolFeeBps: number;
   treasuryAddress: string;
   lockupDurationSeconds: number;
   minInvestmentAmount: string;
}

interface ProtocolStatusResponse {
   globalTradingPaused: boolean;
   pausedAt: string | null;
   protocolFeeBps: number;
   treasuryAddress: string;
   lockupDurationSeconds: number;
   minInvestmentAmount: string;
}

/**
 * Reads the protocol status from the Soroban contract view function.
 *
 * TODO: replace with actual Soroban contract call via stellar-sdk once the
 * get_protocol_status view function is deployed. The current implementation
 * returns a sensible default so the endpoint can be tested end-to-end.
 */
async function readOnChainProtocolStatus(): Promise<OnChainProtocolStatus> {
   // TODO: submit get_protocol_status contract view call via Stellar SDK
   return {
      globalTradingPaused: false,
      protocolFeeBps: 500,
      treasuryAddress: '',
      lockupDurationSeconds: 0,
      minInvestmentAmount: '0',
   };
}

/**
 * GET /protocol/status
 *
 * Returns global trading pause state and protocol-wide configuration values.
 * No authentication required.
 *
 * Response is cached in Redis for 30 seconds. The cache is invalidated
 * whenever an admin updates any protocol config value (see
 * `invalidateProtocolStatusCache`).
 */
router.get('/status', async (_req: Request, res: Response) => {
   try {
      const cached = await cacheGetJson<ProtocolStatusResponse>(
         PROTOCOL_STATUS_CACHE_KEY
      );
      if (cached !== null) {
         sendSuccess(res, cached);
         return;
      }

      const [onChain, config] = await Promise.all([
         readOnChainProtocolStatus(),
         prisma.protocolConfig.findUnique({ where: { id: 'default' } }),
      ]);

      const protocolStatus: ProtocolStatusResponse = {
         globalTradingPaused: onChain.globalTradingPaused,
         pausedAt:
            onChain.globalTradingPaused && config?.pausedAt
               ? config.pausedAt.toISOString()
               : null,
         protocolFeeBps: onChain.protocolFeeBps,
         treasuryAddress: onChain.treasuryAddress,
         lockupDurationSeconds: onChain.lockupDurationSeconds,
         minInvestmentAmount: onChain.minInvestmentAmount,
      };

      await cacheSetJson(
         PROTOCOL_STATUS_CACHE_KEY,
         protocolStatus,
         PROTOCOL_STATUS_CACHE_TTL
      );

      sendSuccess(res, protocolStatus);
   } catch (error) {
      logger.error({ error }, 'Failed to fetch protocol status');
      sendError(
         res,
         500,
         ErrorCode.INTERNAL_ERROR,
         'Failed to fetch protocol status'
      );
   }
});

/**
 * Invalidate the cached protocol status response.
 * Called by admin endpoints that mutate protocol configuration.
 */
export async function invalidateProtocolStatusCache(): Promise<void> {
   await cacheInvalidate(PROTOCOL_STATUS_CACHE_KEY);
}

/**
 * GET /stats
 *
 * Returns protocol-wide statistics:
 * - totalVolume: all time trading volume
 * - activeKeys: number of active creators (with supply > 0)
 * - totalHolders: total number of unique wallets holding keys
 * - trades24h: number of trades in the last 24 hours
 * - volume24h: trading volume in the last 24 hours
 * - trades24hChange: percentage change in trades vs previous 24h window
 * - volume24hChange: percentage change in volume vs previous 24h window
 *
 * Cached in Redis for 5 minutes. No authentication required.
 */
router.get('/stats', async (_req: Request, res: Response) => {
   try {
      const CACHE_KEY = 'protocol:stats';
      const CACHE_TTL = 300; // 5 minutes

      const cached = await cacheGetJson(CACHE_KEY);
      if (cached) {
         sendSuccess(res, cached);
         return;
      }

      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);

      // 1. Total Volume
      const totalVolumeRes = await prisma.$queryRaw<[{ sum: string | null }]>`
         SELECT SUM(price::numeric) as sum FROM "Trade"
      `;
      const totalVolume = totalVolumeRes[0]?.sum || '0';

      // 2. Active Keys (creators with circulating supply > 0)
      const activeKeys = await prisma.creatorProfile.count({
         where: { circulatingSupply: { gt: 0 } },
      });

      // 3. Total Unique Holders (balances > 0)
      const uniqueHoldersRes = await prisma.$queryRaw<[{ count: bigint }]>`
         SELECT COUNT(DISTINCT "ownerAddress") as count FROM "KeyOwnership" WHERE balance > 0
      `;
      const totalHolders = Number(uniqueHoldersRes[0]?.count || 0);

      // 4. Current 24h Window (trades & volume)
      const currentWindowRes = await prisma.$queryRaw<
         [{ count: bigint; sum: string | null }]
      >`
         SELECT COUNT(*) as count, SUM(price::numeric) as sum 
         FROM "Trade" 
         WHERE "timestamp" >= ${oneDayAgo}
      `;
      const trades24h = Number(currentWindowRes[0]?.count || 0);
      const volume24h = currentWindowRes[0]?.sum || '0';

      // 5. Previous 24h Window (trades & volume)
      const previousWindowRes = await prisma.$queryRaw<
         [{ count: bigint; sum: string | null }]
      >`
         SELECT COUNT(*) as count, SUM(price::numeric) as sum 
         FROM "Trade" 
         WHERE "timestamp" >= ${twoDaysAgo} AND "timestamp" < ${oneDayAgo}
      `;
      const prevTrades24h = Number(previousWindowRes[0]?.count || 0);
      const prevVolume24h = previousWindowRes[0]?.sum || '0';

      // Computations for percentages
      const calcChange = (current: number, previous: number) => {
         if (previous === 0) return current > 0 ? 100 : 0;
         return ((current - previous) / previous) * 100;
      };

      const trades24hChange = calcChange(trades24h, prevTrades24h);

      const vCurr = Number(volume24h);
      const vPrev = Number(prevVolume24h);
      const volume24hChange = calcChange(vCurr, vPrev);

      const responseData = {
         totalVolume: String(totalVolume),
         activeKeys,
         totalHolders,
         trades24h,
         volume24h: String(volume24h),
         trades24hChange,
         volume24hChange,
      };

      await cacheSetJson(CACHE_KEY, responseData, CACHE_TTL);

      sendSuccess(res, responseData);
   } catch (error) {
      logger.error({ error }, 'Failed to fetch protocol stats');
      sendError(
         res,
         500,
         ErrorCode.INTERNAL_ERROR,
         'Failed to fetch protocol stats'
      );
   }
});

/**
 * GET /api/v1/fees/current
 * Get current protocol fee tier based on rolling 24h trading volume.
 * Returns active fee percentage, tier label, current volume, and volume until next tier.
 * Cached with 60s TTL.
 * No auth required.
 */
router.get('/fees/current', async (_req: Request, res: Response) => {
   try {
      const currentFee = await getCurrentFeeTier();
      sendSuccess(res, currentFee);
   } catch (error) {
      logger.error({ error }, 'Failed to get current fee tier');
      sendError(
         res,
         500,
         ErrorCode.INTERNAL_ERROR,
         'Failed to get current fee tier'
      );
   }
});

/**
 * GET /api/v1/fees/tiers
 * Get all configured fee tiers.
 * No auth required.
 */
router.get('/fees/tiers', async (_req: Request, res: Response) => {
   try {
      const tiers = await loadFeeTierConfig();
      sendSuccess(res, { tiers });
   } catch (error) {
      logger.error({ error }, 'Failed to get fee tiers');
      sendError(res, 500, ErrorCode.INTERNAL_ERROR, 'Failed to get fee tiers');
   }
});

/**
 * PATCH /api/v1/fees/tiers
 * Admin endpoint to update fee tier configuration.
 * Restricted to admin role.
 * Invalidates cache and records audit trail.
 */
router.patch(
   '/fees/tiers',
   requireJwtAuth,
   adminGuard,
   async (req: Request, res: Response, next) => {
      const parsed = updateFeeTierBodySchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid fee tier update request',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      try {
         const { tiers } = parsed.data;
         const adminId = (req as AdminRequest).adminId || '';
         const updatedTiers = await updateFeeTierConfig(tiers, adminId);
         sendSuccess(
            res,
            { tiers: updatedTiers },
            200,
            'Fee tiers updated successfully'
         );
      } catch (error) {
         if (error instanceof Error) {
            sendError(res, 400, ErrorCode.BAD_REQUEST, error.message);
            return;
         }
         logger.error({ error }, 'Fee tier update failed');
         next(error);
      }
   }
);

export default router;
