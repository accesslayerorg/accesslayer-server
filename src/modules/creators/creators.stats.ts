// src/modules/creators/creators.stats.ts
// Mapper for shaping public creator stats in API responses.

import { CreatorMetrics } from '../../types/profile.types';

/**
 * Public field names exposed by the stats mapper.
 * Single source of truth for what gets included in public stats responses.
 */
export const CREATOR_STATS_FIELDS = [
   'holderCount',
   'totalSupply',
   'totalVolume',
   'currentPrice',
   'lastActivityAt',
] as const;

export type CreatorStatsField = (typeof CREATOR_STATS_FIELDS)[number];

/**
 * Public-facing creator stats shape.
 *
 * Keeps the response focused on what clients need for public endpoints.
 * Avoids leaking internal or sensitive metric fields.
 */
export interface PublicCreatorStats {
   holderCount: number;
   holder_count: number;
   totalSupply: number;
   totalVolume: number;
   /** Current key price in stroops as a string; null when no trade has occurred. */
   currentPrice?: string | null;
   lastActivityAt?: Date;
}

/**
 * Maps each public stats field to its corresponding internal CreatorMetrics key.
 * Currently 1:1, but the indirection lets internal field names change
 * without breaking the public API contract.
 *
 * Uses `as const satisfies` to retain literal types for type-safe indexing
 * while enforcing that all public fields map to valid CreatorMetrics keys.
 */
export const CREATOR_STATS_FIELD_MAP = {
   holderCount: 'holderCount',
   totalSupply: 'totalSupply',
   totalVolume: 'totalVolume',
   currentPrice: 'currentPrice',
   lastActivityAt: 'lastActivityAt',
} as const satisfies Record<CreatorStatsField, keyof CreatorMetrics>;

/**
 * Map a CreatorMetrics object into a public stats response.
 *
 * Uses CREATOR_STATS_FIELD_MAP to build the output, ensuring only
 * mapped fields are included. Optional fields are omitted when undefined.
 *
 * @param metrics - Internal creator metrics
 * @returns Public stats object safe for API responses
 *
 * @example
 * mapPublicCreatorStats({ holderCount: 10, totalSupply: 100, totalVolume: 500 })
 * // => { holderCount: 10, holder_count: 10, totalSupply: 100, totalVolume: 500, currentPrice: null }
 */
export function mapPublicCreatorStats(
   metrics: CreatorMetrics
): PublicCreatorStats {
   const count = metrics[CREATOR_STATS_FIELD_MAP.holderCount];
   return {
      holderCount: count,
      holder_count: count,
      totalSupply: metrics[CREATOR_STATS_FIELD_MAP.totalSupply],
      totalVolume: metrics[CREATOR_STATS_FIELD_MAP.totalVolume],
      currentPrice: metrics[CREATOR_STATS_FIELD_MAP.currentPrice] ?? null,
      ...(metrics[CREATOR_STATS_FIELD_MAP.lastActivityAt] !== undefined
         ? {
              lastActivityAt: metrics[CREATOR_STATS_FIELD_MAP.lastActivityAt],
           }
         : {}),
   };
}
