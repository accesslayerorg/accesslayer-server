import { decodeCreatorFeedCursor } from '../../utils/creator-feed-cursor.utils';
import { logger } from '../../utils/logger.utils';
import { prisma } from '../../utils/prisma.utils';
import { buildCreatorFeedWhere } from './creator-feed-filter-combinator.utils';

export interface WarnIfOutOfRangeCursorParams {
   cursor: string;
   route: string;
   requestId?: string;
   query: { verified?: boolean; search?: string };
}

/**
 * Emits a structured warning log if the client-supplied cursor is out-of-range or invalid.
 * Ensures all errors are caught and handled gracefully so the API response behavior
 * is never affected.
 */
export async function warnIfOutOfRangeCursor(
   params: WarnIfOutOfRangeCursorParams
): Promise<void> {
   const { cursor, route, requestId, query } = params;

   try {
      const decoded = decodeCreatorFeedCursor(cursor);
      if (!decoded.ok) {
         logger.warn({
            msg: 'Out-of-range pagination cursor',
            route,
            cursor,
            error: decoded.error,
            ...(requestId ? { requestId } : {}),
         });
         return;
      }

      const { id, createdAt } = decoded.payload;
      const date = new Date(createdAt);
      if (isNaN(date.getTime())) {
         logger.warn({
            msg: 'Out-of-range pagination cursor',
            route,
            cursor,
            error: 'Invalid date in cursor payload',
            ...(requestId ? { requestId } : {}),
         });
         return;
      }

      const where = buildCreatorFeedWhere(query);

      // Check if the referenced creator profile exists and matches the active filters
      const exists = await prisma.creatorProfile.findFirst({
         where: {
            id,
            createdAt: date,
            ...where,
         },
      });

      if (!exists) {
         logger.warn({
            msg: 'Out-of-range pagination cursor',
            route,
            cursor,
            cursorId: id,
            cursorCreatedAt: createdAt,
            ...(requestId ? { requestId } : {}),
         });
      }
   } catch (error) {
      // Catch all errors (e.g. database connection issues) to guarantee
      // that client requests are never interrupted.
      logger.error({
         msg: 'Error checking pagination cursor range',
         route,
         cursor,
         error: error instanceof Error ? error.message : String(error),
         ...(requestId ? { requestId } : {}),
      });
   }
}
