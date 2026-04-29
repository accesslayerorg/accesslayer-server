import { Prisma } from '@prisma/client';
import {
   CREATOR_LIST_SORT_FIELDS,
   type CreatorListSortField,
} from '../../constants/creator-list-sort.constants';

/**
 * Public sort options accepted by creator list endpoints.
 * These remain stable even if the internal query implementation changes.
 */
export const CREATOR_LIST_SORT_OPTIONS = CREATOR_LIST_SORT_FIELDS;

export const CREATOR_LIST_SORT_ORDERS = ['asc', 'desc'] as const;

export type CreatorListSortOption = CreatorListSortField;
export type CreatorListSortOrder = (typeof CREATOR_LIST_SORT_ORDERS)[number];

const CREATOR_LIST_SORT_FIELD_MAP: Record<
   CreatorListSortOption,
   keyof Prisma.CreatorProfileOrderByWithRelationInput
> = {
   createdAt: 'createdAt',
   updatedAt: 'updatedAt',
   displayName: 'displayName',
   handle: 'handle',
};

/**
 * Map a public sort option into an internal Prisma orderBy object.
 * Throws for unsupported values so invalid sort input is never passed through silently.
 * Handles null values deterministically by sorting nulls last.
 */
export function mapCreatorListSort(
   sort: string,
   order: CreatorListSortOrder
): Prisma.CreatorProfileOrderByWithRelationInput {
   const field = CREATOR_LIST_SORT_FIELD_MAP[sort as CreatorListSortOption];

   if (!field) {
      throw new Error(`Unsupported creator sort option: ${sort}`);
   }

   return {
      [field]: { sort: order, nulls: 'last' },
   } as Prisma.CreatorProfileOrderByWithRelationInput;
}
