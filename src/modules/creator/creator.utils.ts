// src/modules/creator/creator.utils.ts
import { Prisma } from '@prisma/client';

export type CreatorSortField = 'createdAt' | 'handle' | 'displayName';
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
   const validFields: CreatorSortField[] = ['createdAt', 'handle', 'displayName'];
   const validOrders: SortOrder[] = ['asc', 'desc'];

   const field = validFields.includes(sortBy as CreatorSortField)
      ? (sortBy as CreatorSortField)
      : 'createdAt';

   const order = validOrders.includes(sortOrder as SortOrder)
      ? (sortOrder as SortOrder)
      : 'desc';

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
