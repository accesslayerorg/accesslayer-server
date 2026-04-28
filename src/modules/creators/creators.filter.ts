// src/modules/creators/creators.filter.ts
// Parser for creator list filter input. Reusable across list handlers.

import { rejectUnknownKeys } from '../../utils/filter-whitelist.utils';

/**
 * Supported filter keys for creator list requests.
 */
export const SUPPORTED_CREATOR_FILTERS = ['verified', 'search'] as const;

export type CreatorFilterKey = (typeof SUPPORTED_CREATOR_FILTERS)[number];

/**
 * Parsed creator filter input ready for use in list queries.
 */
export interface CreatorFilterInput {
    verified?: boolean;
    search?: string;
}

/**
 * Parse and validate raw query filter input for creator list requests.
 *
 * - Accepts only supported filter keys; rejects unknown ones with an error
 * - Coerces `verified` string to boolean
 * - Trims `search` string
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
 * parseCreatorFilters({ unknown: 'value' })
 * // throws Error: Unsupported creator filter key(s): unknown
 */
export function parseCreatorFilters(
    raw: Record<string, unknown>
): CreatorFilterInput {
    rejectUnknownKeys(SUPPORTED_CREATOR_FILTERS, raw, 'creator filter');

    const result: CreatorFilterInput = {};

    if (raw.verified !== undefined) {
        result.verified = raw.verified === 'true' || raw.verified === true;
    }

    if (typeof raw.search === 'string') {
        const normalized = raw.search.trim().replace(/\s+/g, ' ');
        if (normalized.length > 0) {
            result.search = normalized;
        }
    }

    return result;
}
