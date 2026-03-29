import { Request, Response } from 'express';
import {
   sendError,
   sendSuccess,
   sendValidationError,
   ErrorCode,
} from '../../utils/api-response.utils';
import {
   CreatorProfileParamsSchema,
   UpsertCreatorProfileBodySchema,
} from './creator-profile.schemas';
import {
   getCreatorProfile,
   upsertCreatorProfile,
} from './creator-profile.service';

/**
 * @route GET /api/v1/creators/:creatorId/profile
 * @desc Placeholder creator profile read endpoint
 * @access Public (for scaffold only)
 */
export async function getCreatorProfileHandler(req: Request, res: Response) {
   try {
      const paramsResult = CreatorProfileParamsSchema.safeParse(req.params);
      if (!paramsResult.success) {
         return sendValidationError(
            res,
            'Invalid creator profile path parameters',
            paramsResult.error.issues.map(issue => ({
               field: issue.path.join('.'),
               message: issue.message,
            }))
         );
      }

      const profile = await getCreatorProfile(paramsResult.data.creatorId);
      return sendSuccess(res, profile, 200, 'Creator profile retrieved');
   } catch (error) {
      console.error('Error retrieving creator profile:', error);
      return sendError(
         res,
         500,
         ErrorCode.INTERNAL_ERROR,
         'Failed to retrieve creator profile'
      );
   }
}

/**
 * @route PUT /api/v1/creators/:creatorId/profile
 * @desc Placeholder creator profile write endpoint
 * @access Auth will be required in a follow-up issue
 */
export async function upsertCreatorProfileHandler(req: Request, res: Response) {
   try {
      const paramsResult = CreatorProfileParamsSchema.safeParse(req.params);
      if (!paramsResult.success) {
         return sendValidationError(
            res,
            'Invalid creator profile path parameters',
            paramsResult.error.issues.map(issue => ({
               field: issue.path.join('.'),
               message: issue.message,
            }))
         );
      }

      const bodyResult = UpsertCreatorProfileBodySchema.safeParse(req.body);
      if (!bodyResult.success) {
         return sendValidationError(
            res,
            'Invalid creator profile payload',
            bodyResult.error.issues.map(issue => ({
               field: issue.path.join('.'),
               message: issue.message,
            }))
         );
      }

      const profile = await upsertCreatorProfile(
         paramsResult.data.creatorId,
         bodyResult.data
      );
      return sendSuccess(
         res,
         profile,
         202,
         'Creator profile write accepted (placeholder)'
      );
   } catch (error) {
      console.error('Error upserting creator profile:', error);
      return sendError(
         res,
         500,
         ErrorCode.INTERNAL_ERROR,
         'Failed to upsert creator profile'
      );
   }
}
