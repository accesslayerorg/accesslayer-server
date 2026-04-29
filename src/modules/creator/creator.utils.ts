// src/modules/creator/creator.utils.ts
import { Prisma } from '@prisma/client';
import { resolveSlugCollision } from '../../utils/slug.utils';
import { prisma } from '../../utils/prisma.utils';
import {
   CREATOR_LIST_SORT_FIELDS,
   DEFAULT_CREATOR_LIST_ORDER,
   DEFAULT_CREATOR_LIST_SORT,
   type CreatorListSortField,
} from '../../constants/creator-list-sort.constants';

export type CreatorSortField = CreatorListSortField;
export type SortOrder = 'asc' | 'desc';

export interface CreatorSortOptions {
   field: CreatorSortField;
   order: SortOrder;
}

/**
 * Parse and validate creator sort options.
 * Defaults to createdAt: desc if input is invalid or missing.
 */
export function parseCreatorSortOptions(
   sortBy?: string,
   sortOrder?: string
): CreatorSortOptions {
   const validOrders: SortOrder[] = ['asc', 'desc'];

   const field = CREATOR_LIST_SORT_FIELDS.includes(sortBy as CreatorSortField)
      ? (sortBy as CreatorSortField)
      : DEFAULT_CREATOR_LIST_SORT;

   const order = validOrders.includes(sortOrder as SortOrder)
      ? (sortOrder as SortOrder)
      : DEFAULT_CREATOR_LIST_ORDER;

   return { field, order };
}

/**
 * Convert sort options to Prisma orderBy object.
 */
export function toPrismaOrderBy(
   options: CreatorSortOptions
): Prisma.CreatorProfileOrderByWithRelationInput {
   return {
      [options.field]: options.order,
   };
}

/**
 * Resolves a creator handle (slug) collision using the database.
 *
 * @param displayName - The display name to generate a handle from.
 * @returns A unique handle for the creator.
 */
export async function resolveCreatorSlugCollision(
   displayName: string
): Promise<string> {
   return resolveSlugCollision(displayName, async (handle) => {
      const existing = await prisma.creatorProfile.findUnique({
         where: { handle },
         select: { id: true },
      });
      return !existing;
   });
}
