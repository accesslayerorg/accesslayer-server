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
    totalSupply: number;
    totalVolume: number;
    lastActivityAt?: Date;
}

/**
 * Maps each public stats field to its corresponding internal CreatorMetrics key.
 * Currently 1:1, but the indirection lets internal field names change
 * without breaking the public API contract.
 */
const CREATOR_STATS_FIELD_MAP: Record<
    CreatorStatsField,
    keyof CreatorMetrics
> = {
    holderCount: 'holderCount',
    totalSupply: 'totalSupply',
    totalVolume: 'totalVolume',
    lastActivityAt: 'lastActivityAt',
};

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
 * // => { holderCount: 10, totalSupply: 100, totalVolume: 500 }
 */
export function mapPublicCreatorStats(
    metrics: CreatorMetrics
): PublicCreatorStats {
    const result: Record<string, unknown> = {};

    for (const [publicKey, internalKey] of Object.entries(
        CREATOR_STATS_FIELD_MAP
    )) {
        const value = metrics[internalKey];
        if (value !== undefined) {
            result[publicKey] = value;
        }
    }

    return result as unknown as PublicCreatorStats;
}
