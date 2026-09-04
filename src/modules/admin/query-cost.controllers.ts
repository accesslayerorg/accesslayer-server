import { AsyncController } from '../../types/auth.types';
import { getRedis } from '../../utils/redis.utils';
import { buildQueryCostRedisKey } from '../../utils/query-cost.utils';
import { sendSuccess, sendValidationError } from '../../utils/api-response.utils';
import { logger } from '../../utils/logger.utils';

/**
 * POST /internal/qcost/reset/:walletAddress
 *
 * Clears a wallet's rolling query-cost budget immediately. Internal-network
 * route (see src/modules/index.ts's mount and README) — same convention as
 * the existing /internal/sequencer/clear-drift/:creatorWallet.
 */
export const httpResetQueryCost: AsyncController = async (req, res, next) => {
   try {
      const rawParam = req.params.walletAddress;
      const walletAddress = Array.isArray(rawParam) ? rawParam[0] : rawParam;
      if (!walletAddress) {
         sendValidationError(res, 'Missing walletAddress parameter');
         return;
      }

      const redis = getRedis();
      if (redis) {
         await redis.del(buildQueryCostRedisKey(`wallet:${walletAddress}`));
      }

      logger.warn(
         { type: 'query_cost_reset', walletAddress },
         'Query cost budget reset by operator'
      );

      sendSuccess(res, {
         walletAddress,
         status: 'reset',
         message: `Query cost budget cleared for ${walletAddress}`,
      });
   } catch (err) {
      next(err);
   }
};
