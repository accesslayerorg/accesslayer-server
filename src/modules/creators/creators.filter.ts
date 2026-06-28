// src/modules/creators/creators.filter.ts
// Parser for creator list filter input. Reusable across list handlers.

import { rejectUnknownKeys } from '../../utils/filter-whitelist.utils';
import { parseBoolean } from '../../utils/parseBoolean.utils';

/**
 * Supported filter keys for creator list requests.
 */
export const SUPPORTED_CREATOR_FILTERS = ['verified', 'search', 'minPrice', 'maxPrice'] as const;

export type CreatorFilterKey = (typeof SUPPORTED_CREATOR_FILTERS)[number];

/**
 * Parsed creator filter input ready for use in list queries.
 */
export interface CreatorFilterInput {
    verified?: boolean;
    search?: string;
    minPrice?: bigint;
    maxPrice?: bigint;
}

/**
 * Parse and validate raw query filter input for creator list requests.
 *
 * - Accepts only supported filter keys; rejects unknown ones with an error
 * - Parses `verified` using the shared boolean query flag helper
 * - Trims `search` string
 * - Parses `minPrice` and `maxPrice` as positive BigInt values in stroops
 * - Repeated calls with the same input return the same result
 *
 * @param raw - Raw query object (e.g. req.query)
 * @returns Parsed filter input
 * @throws Error if unsupported filter keys are present
 *
 * @example
 * parseCreatorFilters({ verified: 'true', search: 'jazz' })
 * // => { verified: true, search: 'jazz' }
 *
 * @example
 * parseCreatorFilters({ minPrice: '1000000', maxPrice: '5000000' })
 * // => { minPrice: 1000000n, maxPrice: 5000000n }
 *
 * @example
 * parseCreatorFilters({ unknown: 'value' })
 * // throws Error: Unsupported creator filter key(s): unknown
 */
export function parseCreatorFilters(
    raw: Record<string, unknown>
): CreatorFilterInput {
    rejectUnknownKeys(SUPPORTED_CREATOR_FILTERS, raw, 'creator filter');

    const result: CreatorFilterInput = {};

    if (raw.verified !== undefined) {
        const verified = parseBoolean(
            'verified',
            raw.verified as string | string[] | boolean | null | undefined
        );

        if (verified !== null) {
            result.verified = verified;
        }
    }

    if (typeof raw.search === 'string') {
        const normalized = raw.search.trim().replace(/\s+/g, ' ');
        if (normalized.length > 0) {
            result.search = normalized;
        }
    }

    if (raw.minPrice !== undefined && raw.minPrice !== null && raw.minPrice !== '') {
        const minPriceStr = String(raw.minPrice);
        const minPriceNum = parseInt(minPriceStr, 10);
        if (!isNaN(minPriceNum) && minPriceNum >= 0) {
            result.minPrice = BigInt(minPriceNum);
        }
    }

    if (raw.maxPrice !== undefined && raw.maxPrice !== null && raw.maxPrice !== '') {
        const maxPriceStr = String(raw.maxPrice);
        const maxPriceNum = parseInt(maxPriceStr, 10);
        if (!isNaN(maxPriceNum) && maxPriceNum >= 0) {
            result.maxPrice = BigInt(maxPriceNum);
        }
    }

    return result;
}
