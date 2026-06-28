import { Request, Response } from 'express';
import {
   sendError,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
   ErrorCode,
} from '../../utils/api-response.utils';
import { attachTimestampHeader } from '../../utils/timestamp-headers.utils';
import { logger } from '../../utils/logger.utils';
import {
   CreatorProfileParamsSchema,
   UpsertCreatorProfileBodySchema,
} from './creator-profile.schemas';
import {
   getCreatorProfile,
   upsertCreatorProfile,
} from './creator-profile.service';
import { logCreatorRouteColdStart } from './creator-observability.utils';

/**
 * @route GET /api/v1/creators/:creatorId/profile
 * @desc Placeholder creator profile read endpoint
 * @access Public (for scaffold only)
 */
export async function getCreatorProfileHandler(req: Request, res: Response) {
   try {
      logCreatorRouteColdStart('getCreatorProfileHandler', req.requestId);

      const paramsResult = CreatorProfileParamsSchema.safeParse(req.params);
      if (!paramsResult.success) {
         return sendValidationError(
            res,
            'Invalid creator profile path parameters',
            zodIssuesToDetails(paramsResult.error.issues)
         );
      }

      const profile = await getCreatorProfile(paramsResult.data.creatorId);
      attachTimestampHeader(res);
      return sendSuccess(res, profile, 200, 'Creator profile retrieved');
   } catch (error) {
      logger.error(
         {
            type: 'creator_profile_handler_error',
            handler: 'getCreatorProfileHandler',
            ...(req.requestId ? { requestId: req.requestId } : {}),
            error,
         },
         'Error retrieving creator profile'
      );
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
      logCreatorRouteColdStart('upsertCreatorProfileHandler', req.requestId);

      const paramsResult = CreatorProfileParamsSchema.safeParse(req.params);
      if (!paramsResult.success) {
         return sendValidationError(
            res,
            'Invalid creator profile path parameters',
            zodIssuesToDetails(paramsResult.error.issues)
         );
      }

      const bodyResult = UpsertCreatorProfileBodySchema.safeParse(req.body);
      if (!bodyResult.success) {
         // Log missing required fields with structured context
         const missingFields = bodyResult.error.issues
            .filter(
               (issue: any) =>
                  issue.code === 'invalid_type' &&
                  issue.received === 'undefined'
            )
            .map((issue: any) => issue.path.join('.'));

         if (missingFields.length > 0) {
            logger.warn(
               {
                  type: 'creator_profile_validation_error',
                  handler: 'upsertCreatorProfileHandler',
                  missingFields,
                  ...(req.requestId ? { requestId: req.requestId } : {}),
               },
               'Missing required fields in creator profile payload'
            );
         }

         return sendValidationError(
            res,
            'Invalid creator profile payload',
            zodIssuesToDetails(bodyResult.error.issues)
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
      logger.error(
         {
            type: 'creator_profile_handler_error',
            handler: 'upsertCreatorProfileHandler',
            ...(req.requestId ? { requestId: req.requestId } : {}),
            error,
         },
         'Error upserting creator profile'
      );
      return sendError(
         res,
         500,
         ErrorCode.INTERNAL_ERROR,
         'Failed to upsert creator profile'
      );
   }
}
