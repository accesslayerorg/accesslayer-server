import type { Request } from 'express';
import {
   CREATOR_LIST_SORT_FIELDS,
   type CreatorListSortField,
} from '../../constants/creator-list-sort.constants';
import {
   encodeCreatorListQueryStringValue,
   normalizeCreatorListQueryStringValue,
} from './creators.query-string.utils';
import { logger } from '../../utils/logger.utils';
import { sanitizeLogFieldValue } from '../../utils/log-field-sanitizer.utils';

/**
 * Returns true when `value` is an allowed public creator list sort field.
 */
export function isRecognizedCreatorListSortField(
   value: string
): value is CreatorListSortField {
   return (CREATOR_LIST_SORT_FIELDS as readonly string[]).includes(value);
}

/**
 * Reads the raw `sort` query param from an Express query object.
 */
export function getRawCreatorListSortParam(
   query: Request['query'] | Record<string, unknown>
): string | undefined {
   const raw = query['sort'];
   if (typeof raw === 'string') {
      return raw;
   }
   if (Array.isArray(raw) && typeof raw[0] === 'string') {
      return raw[0];
   }
   return undefined;
}

/**
 * Emits a structured warn log when the client supplied a non-empty sort field
 * outside {@link CREATOR_LIST_SORT_FIELDS}. No-op for recognized or omitted values.
 */
export function warnIfUnrecognizedCreatorListSort(
   query: Request['query'] | Record<string, unknown>,
   requestId?: string
): void {
   const rawSort = getRawCreatorListSortParam(query);
   if (rawSort === undefined) {
      return;
   }

   const normalized = normalizeCreatorListQueryStringValue(rawSort);
   if (
      typeof normalized !== 'string' ||
      isRecognizedCreatorListSortField(normalized)
   ) {
      return;
   }

   logger.warn({
      msg: 'Unrecognized creator list sort field',
      sort: sanitizeLogFieldValue(
         encodeCreatorListQueryStringValue(normalized) ?? normalized
      ),
      ...(requestId ? { requestId } : {}),
   });
}
