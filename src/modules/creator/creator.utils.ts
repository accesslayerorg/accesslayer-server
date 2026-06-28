// src/modules/creator/creator.utils.ts
import { Prisma } from '@prisma/client';
import { resolveSlugCollision } from '../../utils/slug.utils';
import { prisma } from '../../utils/prisma.utils';
import {
   CREATOR_LIST_SORT_ORDERS,
   DEFAULT_CREATOR_LIST_ORDER,
   DEFAULT_CREATOR_LIST_SORT,
   type CreatorListSortField,
   type CreatorListSortOrder,
} from '../../constants/creator-list-sort.constants';
import {
   isRecognizedCreatorListSortField,
   warnIfUnrecognizedCreatorListSort,
} from '../creators/creators.sort-field.utils';
import { sendNotFound } from '../../utils/api-response.utils';
import type { Response } from 'express';

export type CreatorSortField = CreatorListSortField;
export type SortOrder = CreatorListSortOrder;

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
   sortOrder?: string,
   requestId?: string
): CreatorSortOptions {
   if (sortBy !== undefined && sortBy !== '') {
      warnIfUnrecognizedCreatorListSort({ sort: sortBy }, requestId);
   }

   const field =
      sortBy && isRecognizedCreatorListSortField(sortBy)
         ? sortBy
         : DEFAULT_CREATOR_LIST_SORT;

   const order = CREATOR_LIST_SORT_ORDERS.includes(sortOrder as SortOrder)
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

/**
 * Result of a creator param lookup: either the creator exists or has gone missing.
 * Used by endpoint handlers to centralize the not-found response pattern.
 */
export type CreatorParamCheckResult = { id: string; handle: string } | null;

/**
 * Shortcut for returning a 404 when a creator param lookup fails.
 *
 * Encapsulates the common pattern of checking a creator lookup result
 * and returning a not-found response if the creator does not exist.
 * Use this to reduce boilerplate in route handlers that need to validate
 * creator params before proceeding.
 *
 * @param res     - Express Response object (must be passed directly)
 * @param result  - The result from findCreatorByIdOrHandle or similar lookup
 * @returns true if the creator exists (caller should proceed), false if 404 was sent
 *
 * @example
 * const creator = await findCreatorByIdOrHandle(creatorId);
 * if (!handleCreatorParamNotFound(res, creator)) return;
 * // ... proceed with handler logic knowing creator exists
 */
export function handleCreatorParamNotFound<T extends { id: string } | null>(
   res: Response,
   result: T
): result is T extends null ? never : T {
   if (!result) {
      sendNotFound(res, 'Creator');
      return false as const;
   }
   return true as const;
}