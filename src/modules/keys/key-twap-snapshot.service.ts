// src/modules/keys/key-twap-snapshot.service.ts
//
// Read side of GET /keys/:key_id/twap (#1082). Serves the latest indexed
// TWAPUpdated observation per (key, window) from `twap_snapshots`, fronted
// by a 60s cache that the indexer invalidates per key on every new event.

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { envConfig } from '../../config';
import {
   TWAP_SNAPSHOT_CACHE_TTL_SECONDS,
   twapSnapshotCacheKey,
   type TwapWindow,
} from '../../constants/redis.constants';

export interface ValidTwapSnapshot {
   valid: true;
   /** TWAP in stroops, as a string to avoid JS precision loss. */
   twap_price: string;
   window: TwapWindow;
   /** ISO-8601 time the contract computed this TWAP. */
   computed_at: string;
}

export interface InvalidTwapSnapshot {
   valid: false;
   window: TwapWindow;
   /** Observations in the latest snapshot (0 when none has been indexed). */
   observation_count: number;
   min_observations: number;
}

export type TwapSnapshotResult = ValidTwapSnapshot | InvalidTwapSnapshot;

/**
 * Returns the TWAP for a key and window, or an invalid result when the
 * latest snapshot has fewer observations than TWAP_MIN_OBSERVATIONS (or no
 * snapshot exists yet). Both outcomes are cached so an invalid key is as
 * cheap to serve as a valid one.
 *
 * `creatorId` must already be the canonical CreatorProfile id (not a
 * handle) so the cache key matches what the indexer invalidates.
 */
export async function getTwapSnapshot(
   creatorId: string,
   window: TwapWindow
): Promise<TwapSnapshotResult> {
   const cacheKey = twapSnapshotCacheKey(creatorId, window);
   const cached = await cacheGetJson<TwapSnapshotResult>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const minObservations = envConfig.TWAP_MIN_OBSERVATIONS;
   const latest = await prisma.twapSnapshot.findFirst({
      where: { creatorId, window },
      // computedAt first so a late-arriving older event never wins; ledger
      // and eventIndex make ties deterministic.
      orderBy: [
         { computedAt: 'desc' },
         { ledger: 'desc' },
         { eventIndex: 'desc' },
      ],
      select: { twapPrice: true, observationCount: true, computedAt: true },
   });

   const result: TwapSnapshotResult =
      latest && latest.observationCount >= minObservations
         ? {
              valid: true,
              twap_price: latest.twapPrice.toString(),
              window,
              computed_at: latest.computedAt.toISOString(),
           }
         : {
              valid: false,
              window,
              observation_count: latest?.observationCount ?? 0,
              min_observations: minObservations,
           };

   await cacheSetJson(cacheKey, result, TWAP_SNAPSHOT_CACHE_TTL_SECONDS);
   return result;
}
