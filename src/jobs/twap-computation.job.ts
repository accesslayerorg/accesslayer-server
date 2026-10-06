// src/jobs/twap-computation.job.ts
// Background TWAP computation for all active creator keys (#963).
// Runs every 5 minutes per key per window (1h, 4h, 24h) and pre-warms
// the Redis cache so GET /keys/:keyId/price/twap stays a cache hit.

import { envConfig } from '../config';
import { logger } from '../utils/logger.utils';
import { prisma } from '../utils/prisma.utils';
import { TWAP_WINDOWS } from '../constants/redis.constants';
import {
   computeAndCacheTwap,
   KeyNotFoundError,
} from '../modules/keys/key-twap.service';
import { keyEventEmitter } from '../modules/keys/key-registration.service';

export type TwapComputationResult = {
   scannedKeys: number;
   computedWrites: number;
   failedWrites: number;
};

/**
 * Compute and cache TWAP for every active key (deprecatedAt null)
 * across all windows. Missing keys are covered on each run, which is
 * also the backfill path for newly created keys.
 */
export async function computeTwapForAllKeys(
   now: Date = new Date()
): Promise<TwapComputationResult> {
   const activeKeys = await prisma.creatorProfile.findMany({
      where: { deprecatedAt: null },
      select: { id: true },
   });

   let computedWrites = 0;
   let failedWrites = 0;

   for (const key of activeKeys as Array<{ id: string }>) {
      for (const window of TWAP_WINDOWS) {
         try {
            await computeAndCacheTwap(key.id, window, now);
            computedWrites += 1;
         } catch (error) {
            failedWrites += 1;
            logger.warn(
               { error, keyId: key.id, window },
               'twap-computation: failed for key/window'
            );
         }
      }
   }

   logger.info(
      { scannedKeys: activeKeys.length, computedWrites, failedWrites },
      'twap-computation: completed'
   );

   return {
      scannedKeys: activeKeys.length,
      computedWrites,
      failedWrites,
   };
}

/** Immediate backfill for a single key across all windows. */
export async function backfillTwapForKey(
   keyId: string,
   now: Date = new Date()
): Promise<void> {
   try {
      for (const window of TWAP_WINDOWS) {
         await computeAndCacheTwap(keyId, window, now);
      }
   } catch (error) {
      if (error instanceof KeyNotFoundError) {
         logger.warn(
            { keyId },
            'twap-computation: backfill skipped, key not found'
         );
         return;
      }
      throw error;
   }
}

let twapTimer: ReturnType<typeof setInterval> | null = null;
let registrationHooked = false;

function onKeyRegistered(payload: { keyAddress?: string }): void {
   // RegisteredKey.keyAddress has no direct CreatorProfile mapping yet,
   // so best-effort backfill the address as a key id and always sweep
   // missing keys so a new CreatorProfile is covered within seconds.
   void (async () => {
      try {
         if (payload?.keyAddress) {
            await backfillTwapForKey(payload.keyAddress).catch(() => {});
         }
         await computeTwapForAllKeys().catch(() => {});
      } catch (error) {
         logger.error(
            { err: error },
            'twap-computation: registration backfill failed'
         );
      }
   })();
}

export function startTwapComputationJob(): void {
   if (!envConfig.TWAP_COMPUTATION_ENABLED) {
      logger.info('twap-computation job is disabled');
      return;
   }

   const intervalMs = envConfig.TWAP_COMPUTATION_INTERVAL_MINUTES * 60 * 1000;

   const run = async () => {
      try {
         await computeTwapForAllKeys();
      } catch (error) {
         logger.error(
            { err: error },
            'twap-computation failed with an unexpected error'
         );
      }
   };

   void run();
   twapTimer = setInterval(() => {
      void run();
   }, intervalMs);

   if (
      typeof (twapTimer as unknown as { unref?: () => void }).unref ===
      'function'
   ) {
      (twapTimer as unknown as { unref: () => void }).unref();
   }

   if (!registrationHooked) {
      keyEventEmitter.on('key_registered', onKeyRegistered);
      registrationHooked = true;
   }

   logger.info(
      { intervalMinutes: envConfig.TWAP_COMPUTATION_INTERVAL_MINUTES },
      'twap-computation job started'
   );
}

export function stopTwapComputationJob(): void {
   if (twapTimer) {
      clearInterval(twapTimer);
      twapTimer = null;
   }
   if (registrationHooked) {
      keyEventEmitter.removeListener('key_registered', onKeyRegistered);
      registrationHooked = false;
   }
   logger.info('twap-computation job stopped');
}
