import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import { envConfig } from '../../config';

export const TWAP_WINDOWS = ['1h', '24h', '7d'] as const;
export type TwapWindow = (typeof TWAP_WINDOWS)[number];

export const TWAP_WINDOW_MS: Record<TwapWindow, number> = {
   '1h': 60 * 60 * 1000,
   '24h': 24 * 60 * 60 * 1000,
   '7d': 7 * 24 * 60 * 60 * 1000,
};

// Ledgers close every ~5 seconds on Stellar/Soroban
export const TWAP_WINDOW_LEDGERS: Record<TwapWindow, number> = {
   '1h': 720,
   '24h': 17280,
   '7d': 120960,
};

export const TWAP_CACHE_TTL_SECONDS = 60;

export interface TwapResult {
   keyId: string;
   window: TwapWindow;
   windowLedgers: number;
   twapPrice: string | null;
   spotPrice: string;
   snapshotCount: number;
}

export function buildTwapCacheKey(keyId: string, window: TwapWindow): string {
   return `key:twap:${keyId}:${window}`;
}

export async function invalidateKeyTwapCache(keyId: string): Promise<void> {
   await cacheInvalidate(`key:twap:${keyId}:*`);
}

/**
 * Attempts to query on-chain Soroban contract get_twap view via RPC.
 */
async function fetchOnChainTwap(
   contractId: string,
   windowLedgers: number
): Promise<string | null> {
   if (!envConfig.STELLAR_SOROBAN_RPC_URL) {
      return null;
   }

   try {
      const response = await fetch(envConfig.STELLAR_SOROBAN_RPC_URL, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'get_twap_view',
            method: 'simulateTransaction',
            params: {
               contractId,
               functionName: 'get_twap',
               args: [windowLedgers],
            },
         }),
      });

      if (!response.ok) return null;

      const json = await response.json();
      if (json.result?.results?.[0]?.xdr) {
         return json.result.results[0].xdr.toString();
      }
   } catch (err) {
      logger.debug({ err, contractId }, 'get_twap on-chain view query skipped');
   }

   return null;
}

export async function getKeyTwap(
   creatorId: string,
   window: TwapWindow,
   now: Date = new Date()
): Promise<TwapResult> {
   const cacheKey = buildTwapCacheKey(creatorId, window);
   const cached = await cacheGetJson<TwapResult>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const windowMs = TWAP_WINDOW_MS[window];
   const windowLedgers = TWAP_WINDOW_LEDGERS[window];
   const windowStart = new Date(now.getTime() - windowMs);

   // Log get_twap contract view call with window in ledger units
   logger.info(
      {
         operation: 'get_twap_contract_view',
         keyId: creatorId,
         window,
         windowLedgers,
      },
      'Calling get_twap contract view'
   );

   // 1. Try on-chain Soroban view
   const onChainPrice = await fetchOnChainTwap(creatorId, windowLedgers);
   if (onChainPrice !== null) {
      const priceSnapshot = await prisma.creatorPriceSnapshot.findUnique({
         where: { creatorId },
         select: { currentPrice: true },
      });
      const result: TwapResult = {
         keyId: creatorId,
         window,
         windowLedgers,
         twapPrice: onChainPrice,
         spotPrice: priceSnapshot?.currentPrice.toString() ?? onChainPrice,
         snapshotCount: 0,
      };
      await cacheSetJson(cacheKey, result, TWAP_CACHE_TTL_SECONDS);
      return result;
   }

   // 2. Derive contract-backed calculation using stored price snapshots
   const [snapshots, priceSnapshot] = await Promise.all([
      prisma.creatorPriceHistory.findMany({
         where: {
            creatorId,
            recordedAt: { gte: windowStart, lte: now },
         },
         orderBy: { recordedAt: 'asc' },
      }),
      prisma.creatorPriceSnapshot.findUnique({
         where: { creatorId },
         select: { currentPrice: true },
      }),
   ]);

   const spotPrice = priceSnapshot
      ? priceSnapshot.currentPrice.toString()
      : snapshots.length > 0
      ? snapshots[snapshots.length - 1].price.toString()
      : '0';

   let twapPrice: string | null = null;

   if (snapshots.length >= 2) {
      let totalTimeWeight = 0;
      let weightedPriceSum = 0n;

      for (let i = 0; i < snapshots.length - 1; i++) {
         const tCurrent = snapshots[i].recordedAt.getTime();
         const tNext = snapshots[i + 1].recordedAt.getTime();
         const dt = Math.max(0, tNext - tCurrent);

         if (dt > 0) {
            // Accumulate doubled sum: (P_i + P_{i+1}) * dt to prevent premature integer truncation
            weightedPriceSum += (snapshots[i].price + snapshots[i + 1].price) * BigInt(dt);
            totalTimeWeight += dt;
         }
      }

      if (totalTimeWeight > 0) {
         // Divide once at the end by 2 * totalTimeWeight
         twapPrice = (weightedPriceSum / (2n * BigInt(totalTimeWeight))).toString();
      } else {
         const sum = snapshots.reduce((acc, s) => acc + s.price, 0n);
         twapPrice = (sum / BigInt(snapshots.length)).toString();
      }
   }

   const result: TwapResult = {
      keyId: creatorId,
      window,
      windowLedgers,
      twapPrice,
      spotPrice,
      snapshotCount: snapshots.length,
   };

   await cacheSetJson(cacheKey, result, TWAP_CACHE_TTL_SECONDS);
   return result;
}
