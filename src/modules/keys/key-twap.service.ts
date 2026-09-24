import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';

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
            // Trapezoidal average between consecutive snapshots
            const avgPrice = (snapshots[i].price + snapshots[i + 1].price) / 2n;
            weightedPriceSum += avgPrice * BigInt(dt);
            totalTimeWeight += dt;
         }
      }

      if (totalTimeWeight > 0) {
         twapPrice = (weightedPriceSum / BigInt(totalTimeWeight)).toString();
      } else {
         // All snapshots occurred at the same millisecond; simple arithmetic mean
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
