// src/modules/users/holdings.controller.ts
// Handler + cache plumbing for GET /api/v1/users/:wallet/holdings.
//
// Holdings are cached for a short window and invalidated on trades via
// `invalidateHoldingsCache`, which buy/sell ingestion paths must call.

import { Response } from 'express';
import { ErrorCode, sendError, sendSuccess } from '../../utils/api-response.utils';
import { attachTimestampHeader } from '../../utils/timestamp-headers.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';
import { AuthenticatedRequest } from '../../middlewares/jwt-auth.middleware';
import { buildHoldingsCacheKey } from './holdings.constants';
import { getWalletHoldings, HoldingView } from './holdings.service';

/** Holdings cache TTL (60s): balances change on trade, invalidated eagerly. */
const HOLDINGS_CACHE_TTL_SECONDS = 60;

export async function httpGetWalletHoldings(
   req: AuthenticatedRequest,
   res: Response
): Promise<void> {
   try {
      const wallet = (
         Array.isArray(req.params.wallet) ? req.params.wallet[0] : req.params.wallet
      ).trim();

      const cacheKey = buildHoldingsCacheKey(wallet);
      const cached = await cacheGetJson<HoldingView[]>(cacheKey);
      if (cached) {
         attachTimestampHeader(res);
         sendSuccess(res, { holdings: cached }, 200);
         return;
      }

      const holdings = await getWalletHoldings(wallet);

      await cacheSetJson(cacheKey, holdings, HOLDINGS_CACHE_TTL_SECONDS);

      attachTimestampHeader(res);
      sendSuccess(res, { holdings }, 200);
   } catch (error) {
      logger.error(
         {
            type: 'holdings_handler_error',
            handler: 'httpGetWalletHoldings',
            ...(req.requestId ? { requestId: req.requestId } : {}),
            error,
         },
         'Failed to retrieve wallet holdings'
      );
      sendError(res, 500, ErrorCode.INTERNAL_ERROR, 'Failed to retrieve wallet holdings');
   }
}

/**
 * Invalidate the cached holdings payload for a wallet. Call after every buy
 * or sell affecting the wallet.
 */
export async function invalidateHoldingsCache(wallet: string): Promise<void> {
   await cacheInvalidate(buildHoldingsCacheKey(wallet));
}
