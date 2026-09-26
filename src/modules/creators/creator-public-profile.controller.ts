// src/modules/creators/creator-public-profile.controller.ts
// HTTP controllers for the public creator profile endpoints (#900).

import { AsyncController } from '../../types/auth.types';
import {
   sendSuccess,
   sendNotFound,
   sendValidationError,
} from '../../utils/api-response.utils';
import { attachTimestampHeader } from '../../utils/timestamp-headers.utils';
import {
   getCreatorPublicProfile,
   getCreatorIssuedKeys,
} from './creator-public-profile.service';

/**
 * GET /api/v1/creators/:id
 *
 * Returns the public profile for a creator together with social stats
 * (total holders, total trading volume, followers count).
 *
 * No authentication required. Resolves by creator ID or handle.
 */
export const httpGetCreatorPublicProfile: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      const rawId = req.params.id;
      const creatorId = Array.isArray(rawId) ? rawId[0] : rawId;

      const profile = await getCreatorPublicProfile(creatorId);
      if (!profile) {
         return sendNotFound(res, 'Creator');
      }

      attachTimestampHeader(res);
      return sendSuccess(res, profile, 200, 'Creator profile retrieved successfully');
   } catch (error) {
      next(error);
   }
};

/**
 * GET /api/v1/creators/:id/keys
 *
 * Returns a cursor-paginated list of keys (CreatorProfile records) issued by
 * the same user who owns the given creator profile, together with aggregate
 * stats across all their keys.
 *
 * Query params:
 *   - limit  (optional, 1–100, default 20)
 *   - cursor (optional, opaque pagination cursor)
 *
 * No authentication required. Resolves by creator ID or handle.
 */
export const httpGetCreatorIssuedKeys: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      const rawId = req.params.id;
      const creatorId = Array.isArray(rawId) ? rawId[0] : rawId;

      const rawLimit = req.query.limit;
      const rawCursor = req.query.cursor;

      // Reject repeated query params
      if (
         (rawLimit !== undefined && typeof rawLimit !== 'string') ||
         (rawCursor !== undefined && typeof rawCursor !== 'string')
      ) {
         return sendValidationError(
            res,
            'Invalid keys pagination parameters',
            [
               {
                  field: 'pagination',
                  message: 'limit and cursor must each be provided once',
               },
            ]
         );
      }

      const page = await getCreatorIssuedKeys(
         creatorId,
         rawLimit,
         rawCursor
      );

      if (page === null) {
         return sendNotFound(res, 'Creator');
      }

      attachTimestampHeader(res);
      return sendSuccess(res, page, 200, 'Creator keys retrieved successfully');
   } catch (error) {
      if (
         error instanceof Error &&
         error.message.startsWith('Invalid keys pagination')
      ) {
         return sendValidationError(
            res,
            'Invalid keys pagination parameters',
            [{ field: 'pagination', message: error.message }]
         );
      }
      next(error);
   }
};
