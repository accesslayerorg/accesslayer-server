// src/modules/creator/creator.utils.ts
import { Prisma } from '@prisma/client';
import { Response } from 'express';
import { prisma } from '../../utils/prisma.utils';
import { sendNotFound } from '../../utils/api-response.utils';

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

/**
 * Shortcut helper for returning a not-found response when a creator param is missing.
 *
 * This reduces repeated route-level boilerplate by centralizing the creator
 * not-found check. If the creator exists, it returns the creator object.
 * If not found, it sends a 404 response and returns null.
 *
 * @param res - Express response object
 * @param creatorId - Creator ID to look up
 * @returns Creator profile if found, null otherwise (with 404 response already sent)
 *
 * @example
 * const creator = await getCreatorOrNotFound(res, creatorId);
 * if (!creator) return; // 404 already sent
 * // Continue with creator...
 */
export async function getCreatorOrNotFound(
   res: Response,
   creatorId: string
): Promise<Prisma.CreatorProfileGetPayload<{}> | null> {
   const creator = await prisma.creatorProfile.findUnique({
      where: { id: creatorId },
   });

   if (!creator) {
      sendNotFound(res, 'Creator');
      return null;
   }

   return creator;
}

/**
 * Shortcut helper for returning a not-found response when a creator handle param is missing.
 *
 * Similar to getCreatorOrNotFound, but looks up creators by handle instead of ID.
 *
 * @param res - Express response object
 * @param handle - Creator handle to look up
 * @returns Creator profile if found, null otherwise (with 404 response already sent)
 *
 * @example
 * const creator = await getCreatorByHandleOrNotFound(res, handle);
 * if (!creator) return; // 404 already sent
 * // Continue with creator...
 */
export async function getCreatorByHandleOrNotFound(
   res: Response,
   handle: string
): Promise<Prisma.CreatorProfileGetPayload<{}> | null> {
   const creator = await prisma.creatorProfile.findUnique({
      where: { handle },
   });

   if (!creator) {
      sendNotFound(res, 'Creator');
      return null;
   }

   return creator;
}
