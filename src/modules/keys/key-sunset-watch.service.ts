// src/modules/keys/key-sunset-watch.service.ts
// Service backing GET /keys/sunset-watch (#931).
//
// Returns all creator keys that are:
//   (a) already flagged on-chain (sunsetFlaggedAt IS NOT NULL), OR
//   (b) approaching the inactivity sunset threshold — i.e. the most recent
//       KEY_BOUGHT or KEY_SOLD activity for the key is older than
//       KEY_SUNSET_INACTIVITY_THRESHOLD_DAYS days (or the key has never traded).
//
// Each result item carries:
//   - daysSinceLastTrade  — whole days since the last trade Activity record,
//                           or null when the key has never traded
//   - sunsetStatus        — 'sunset_pending'     : on-chain flag is set
//                           'threshold_exceeded' : last trade ≥ threshold days ago
//                                                  (or never traded)
//                           'near_threshold'     : last trade is within the
//                                                  threshold but past the
//                                                  near-window cutoff
//
// Results are sorted by daysSinceLastTrade descending (most inactive first);
// keys that have never traded sort last within the list.

import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';
import { buildOffsetPaginationMeta } from '../../utils/pagination.utils';

// ── Types ────────────────────────────────────────────────────

export type SunsetStatus =
   | 'sunset_pending'
   | 'threshold_exceeded'
   | 'near_threshold';

export interface SunsetWatchItem {
   keyId: string;
   handle: string;
   displayName: string;
   circulatingSupply: string;
   /** ISO timestamp of the last KEY_BOUGHT / KEY_SOLD activity, or null. */
   lastTradeAt: string | null;
   /** Whole days elapsed since last trade, or null if never traded. */
   daysSinceLastTrade: number | null;
   /** ISO timestamp when the on-chain KeySunsetFlagged event was processed, or null. */
   sunsetFlaggedAt: string | null;
   sunsetStatus: SunsetStatus;
}

export interface SunsetWatchResult {
   items: SunsetWatchItem[];
   meta: ReturnType<typeof buildOffsetPaginationMeta>;
}

export interface SunsetWatchQuery {
   limit: number;
   offset: number;
}

// ── Internal helpers ─────────────────────────────────────────

/** Whole elapsed days between `date` and now, floored to the nearest integer. */
function daysSince(date: Date): number {
   return Math.floor((Date.now() - date.getTime()) / 86_400_000);
}

/**
 * Derive the human-readable sunset status for a single key.
 *
 * Near-threshold window: the lesser of 7 days or half the configured threshold.
 * A key is "near_threshold" when its last trade falls inside that window
 * before the threshold, but has not been flagged on-chain.
 */
function deriveSunsetStatus(
   sunsetFlaggedAt: Date | null,
   daysSinceLastTrade: number | null,
   thresholdDays: number,
   nearWindowDays: number
): SunsetStatus {
   if (sunsetFlaggedAt !== null) {
      return 'sunset_pending';
   }
   if (
      daysSinceLastTrade === null ||
      daysSinceLastTrade >= thresholdDays
   ) {
      return 'threshold_exceeded';
   }
   // daysSinceLastTrade < thresholdDays, but within the near window
   if (daysSinceLastTrade >= thresholdDays - nearWindowDays) {
      return 'near_threshold';
   }
   // Should not reach here (caller only passes candidates in the window),
   // but guard defensively.
   return 'near_threshold';
}

// ── Main query ───────────────────────────────────────────────

/**
 * Fetch all keys approaching or past the inactivity sunset threshold plus
 * all keys already flagged on-chain, sorted by inactivity descending.
 *
 * Strategy:
 *  1. Pull all CreatorProfile rows that have sunsetFlaggedAt set.
 *  2. Pull the max(createdAt) per creatorId from Activity for trade types,
 *     using Prisma groupBy, to find each key's last trade date.
 *  3. Merge: include a key if it is flagged OR its last trade predates the
 *     near-threshold cutoff OR it has never traded.
 *  4. Sort, then paginate in-memory (the eligible set is bounded and small).
 */
export async function getSunsetWatchList(
   query: SunsetWatchQuery
): Promise<SunsetWatchResult> {
   const { limit, offset } = query;
   const thresholdDays = envConfig.KEY_SUNSET_INACTIVITY_THRESHOLD_DAYS;
   const nearWindowDays = Math.min(7, Math.floor(thresholdDays / 2));
   const nearCutoff = new Date(
      Date.now() - (thresholdDays - nearWindowDays) * 86_400_000
   );

   // ── 1. Fetch all profiles in a single query ──────────────
   // We need all profiles to cross-reference against the activity aggregation.
   // CreatorProfile counts are bounded (one per creator), so a full scan is fine.
   const allProfiles = await prisma.creatorProfile.findMany({
      select: {
         id: true,
         handle: true,
         displayName: true,
         circulatingSupply: true,
         sunsetFlaggedAt: true,
      },
   });

   // ── 2. Aggregate last trade date per creatorId ───────────
   // groupBy returns one row per creatorId with the latest createdAt.
   const lastTradeRows = await prisma.activity.groupBy({
      by: ['creatorId'],
      where: {
         type: { in: ['KEY_BOUGHT', 'KEY_SOLD'] },
         creatorId: { not: null },
      },
      _max: { createdAt: true },
   });

   const lastTradeMap = new Map<string, Date>();
   for (const row of lastTradeRows) {
      if (row.creatorId && row._max.createdAt) {
         lastTradeMap.set(row.creatorId, row._max.createdAt);
      }
   }

   // ── 3. Filter, enrich, and sort ──────────────────────────
   type EnrichedItem = SunsetWatchItem & { _sortKey: number };
   const candidates: EnrichedItem[] = [];

   for (const profile of allProfiles) {
      const lastTradeDate = lastTradeMap.get(profile.id) ?? null;
      const days = lastTradeDate !== null ? daysSince(lastTradeDate) : null;

      // Include the key if it is flagged on-chain OR its last trade is old
      // enough to be near/past the threshold OR it has never traded.
      const isFlagged = profile.sunsetFlaggedAt !== null;
      const isOldEnough =
         lastTradeDate === null || lastTradeDate < nearCutoff;

      if (!isFlagged && !isOldEnough) {
         continue;
      }

      candidates.push({
         keyId: profile.id,
         handle: profile.handle,
         displayName: profile.displayName,
         circulatingSupply: profile.circulatingSupply.toString(),
         lastTradeAt: lastTradeDate?.toISOString() ?? null,
         daysSinceLastTrade: days,
         sunsetFlaggedAt: profile.sunsetFlaggedAt?.toISOString() ?? null,
         sunsetStatus: deriveSunsetStatus(
            profile.sunsetFlaggedAt,
            days,
            thresholdDays,
            nearWindowDays
         ),
         // Never-traded keys sort after known-inactive keys (use large sentinel).
         _sortKey: days ?? Number.MAX_SAFE_INTEGER,
      });
   }

   // Sort descending: most inactive first; never-traded last.
   candidates.sort((a, b) => b._sortKey - a._sortKey);

   // ── 4. Paginate ──────────────────────────────────────────
   const total = candidates.length;
   const page = candidates.slice(offset, offset + limit);
   const items: SunsetWatchItem[] = page.map(
      ({ _sortKey: _unused, ...item }) => item
   );

   return {
      items,
      meta: buildOffsetPaginationMeta({ limit, offset, total }),
   };
}
