import { z } from 'zod';
import { normalizeCreatorListQueryStringValue } from './creators.query-string.utils';

export const CREATOR_LIST_INCLUDE_VALUES = ['stats'] as const;

export type CreatorListIncludeValue =
   (typeof CREATOR_LIST_INCLUDE_VALUES)[number];

const creatorListIncludeValueEnum = z.enum(CREATOR_LIST_INCLUDE_VALUES);

function normalizeCreatorListIncludeValue(value: unknown): unknown {
   if (Array.isArray(value)) {
      return value.map(item => normalizeCreatorListQueryStringValue(item));
   }

   const normalized = normalizeCreatorListQueryStringValue(value);
   if (typeof normalized !== 'string') {
      return normalized;
   }

   return normalized.split(',').map(part => part.trim());
}

/**
 * Zod schema for the creator list `include` query parameter.
 *
 * - Supports comma-separated include values such as `stats`.
 * - Rejects unsupported include values through normal schema validation.
 * - Can be reused anywhere creator list query params are parsed.
 */
export function creatorListIncludeQueryParam() {
   return z.preprocess(
      normalizeCreatorListIncludeValue,
      z.array(creatorListIncludeValueEnum).optional()
   );
}
