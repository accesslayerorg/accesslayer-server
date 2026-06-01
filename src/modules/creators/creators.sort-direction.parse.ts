import { z } from 'zod';
import {
   CREATOR_LIST_SORT_ORDERS,
   DEFAULT_CREATOR_LIST_ORDER,
   type CreatorListSortOrder,
} from '../../constants/creator-list-sort.constants';
import { normalizeCreatorListQueryStringValue } from './creators.query-string.utils';

const creatorListSortDirectionEnum = z.enum(CREATOR_LIST_SORT_ORDERS);

/**
 * Zod schema for the creator list `order` query parameter (sort direction).
 *
 * - Only `asc` and `desc` are accepted (see {@link CREATOR_LIST_SORT_ORDERS}).
 * - Omitted or empty values use {@link DEFAULT_CREATOR_LIST_ORDER}.
 * - Invalid values fail parse so {@link parsePublicQuery} returns structured validation errors.
 */
export function creatorListSortDirectionQueryParam(
   defaultOrder: CreatorListSortOrder = DEFAULT_CREATOR_LIST_ORDER
) {
   return z.preprocess(
      normalizeCreatorListQueryStringValue,
      creatorListSortDirectionEnum.optional().default(defaultOrder)
   );
}
