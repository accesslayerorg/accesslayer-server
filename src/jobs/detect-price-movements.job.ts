// src/jobs/detect-price-movements.job.ts
import { envConfig } from '../config';
import { logger } from '../utils/logger.utils';
import { prisma } from '../utils/prisma.utils';
import { PRICE_MOVED_THRESHOLD_PCT } from '../constants/notifications.constants';
import { writePriceMovedKeys } from '../modules/keys/price-moved.redis';

export type DetectPriceMovementsResult = {
   scanned: number;
   flagged: number;
   keyIds: string[];
};

function percentChange(current: bigint, baseline: bigint): number | null {
   if (baseline === 0n) {
      return null;
   }
   // Use number math for percentage; prices are stroops but ratio is unitless.
   const currentNum = Number(current);
   const baselineNum = Number(baseline);
   if (!Number.isFinite(currentNum) || !Number.isFinite(baselineNum)) {
      return null;
   }
   return ((currentNum - baselineNum) / baselineNum) * 100;
}

/**
 * Compare each active key's current price to its 24h-ago snapshot and write
 * keys that moved more than PRICE_MOVED_THRESHOLD_PCT into Redis.
 */
export async function detectPriceMovements(): Promise<DetectPriceMovementsResult> {
   const snapshots = await prisma.creatorPriceSnapshot.findMany({
      where: {
         currentPrice: { gt: 0 },
         price24hAgo: { gt: 0 },
      },
      select: {
         creatorId: true,
         currentPrice: true,
         price24hAgo: true,
      },
   });

   const flagged: string[] = [];
   for (const snapshot of snapshots) {
      const change = percentChange(snapshot.currentPrice, snapshot.price24hAgo);
      if (change !== null && Math.abs(change) > PRICE_MOVED_THRESHOLD_PCT) {
         flagged.push(snapshot.creatorId);
      }
   }

   await writePriceMovedKeys(flagged);

   logger.info(
      {
         scanned: snapshots.length,
         flagged: flagged.length,
      },
      'detectPriceMovements: completed'
   );

   return {
      scanned: snapshots.length,
      flagged: flagged.length,
      keyIds: flagged,
   };
}

let priceMovementTimer: ReturnType<typeof setInterval> | null = null;

export function startDetectPriceMovementsJob(): void {
   if (!envConfig.DETECT_PRICE_MOVEMENTS_ENABLED) {
      logger.info('detectPriceMovements job is disabled');
      return;
   }

   const intervalMs =
      envConfig.DETECT_PRICE_MOVEMENTS_INTERVAL_MINUTES * 60 * 1000;

   const run = async () => {
      try {
         await detectPriceMovements();
      } catch (error) {
         logger.error(
            { err: error },
            'detectPriceMovements failed with an unexpected error'
         );
      }
   };

   void run();
   priceMovementTimer = setInterval(() => {
      void run();
   }, intervalMs);

   if (
      typeof (priceMovementTimer as unknown as { unref?: () => void }).unref ===
      'function'
   ) {
      (priceMovementTimer as unknown as { unref: () => void }).unref();
   }

   logger.info(
      {
         intervalMinutes: envConfig.DETECT_PRICE_MOVEMENTS_INTERVAL_MINUTES,
      },
      'detectPriceMovements job started'
   );
}

export function stopDetectPriceMovementsJob(): void {
   if (!priceMovementTimer) {
      return;
   }
   clearInterval(priceMovementTimer);
   priceMovementTimer = null;
   logger.info('detectPriceMovements job stopped');
}
