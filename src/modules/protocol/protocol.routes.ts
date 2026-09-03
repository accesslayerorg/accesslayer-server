import { Router, Request, Response } from 'express';
import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';
import {
   sendSuccess,
   sendError,
   ErrorCode,
} from '../../utils/api-response.utils';
import { logger } from '../../utils/logger.utils';

const router = Router();

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

export default router;
