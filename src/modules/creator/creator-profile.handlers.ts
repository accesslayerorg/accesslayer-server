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
   UpsertCreatorProfileBody,
} from './creator-profile.schemas';
import {
   getCreatorProfile,
   upsertCreatorProfile,
} from './creator-profile.service';
import {
   CreatorSocialProfileNotFoundError,
   getCreatorSocialMetadata,
} from './creator-social-metadata-sync.service';
import { logCreatorRouteColdStart } from './creator-observability.utils';

/**
 * @route GET /api/v1/creators/:wallet/social
 * @desc Creator social metadata endpoint (#1037): display name, bio, avatar URL, social links
 * @access Public
 */
export async function getCreatorSocialHandler(req: Request, res: Response) {
   try {
      logCreatorRouteColdStart('getCreatorSocialHandler', req.requestId);

      const paramsResult = CreatorProfileParamsSchema.safeParse(req.params);
      if (!paramsResult.success) {
         return sendValidationError(
            res,
            'Invalid creator social path parameters',
            zodIssuesToDetails(paramsResult.error.issues)
         );
      }

      const rawIdentifier =
         paramsResult.data.wallet ||
         paramsResult.data.creatorId ||
         req.params.wallet ||
         req.params.creatorId ||
         req.params.id;
      const identifier = Array.isArray(rawIdentifier)
         ? rawIdentifier[0]
         : String(rawIdentifier);

      const social = await getCreatorSocialMetadata(identifier);
      attachTimestampHeader(res);
      return sendSuccess(
         res,
         social,
         200,
         'Creator social metadata retrieved'
      );
   } catch (error) {
      if (error instanceof CreatorSocialProfileNotFoundError) {
         return sendError(
            res,
            404,
            ErrorCode.NOT_FOUND,
            'Creator social profile not found'
         );
      }
      logger.error(
         {
            type: 'creator_social_handler_error',
            handler: 'getCreatorSocialHandler',
            ...(req.requestId ? { requestId: req.requestId } : {}),
            error,
         },
         'Error retrieving creator social metadata'
      );
      return sendError(
         res,
         500,
         ErrorCode.INTERNAL_ERROR,
         'Failed to retrieve creator social metadata'
      );
   }
}

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

      const rawIdentifier =
         paramsResult.data.wallet ||
         paramsResult.data.creatorId ||
         req.params.wallet ||
         req.params.creatorId ||
         req.params.id;
      const identifier = Array.isArray(rawIdentifier)
         ? rawIdentifier[0]
         : String(rawIdentifier);

      const profile = await getCreatorProfile(identifier);
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

      // Body is already validated and stripped of unknown fields by the
      // validateBody(UpsertCreatorProfileBodySchema) middleware on this route.
      const body = req.body as UpsertCreatorProfileBody;

      const rawIdentifier =
         paramsResult.data.wallet ||
         paramsResult.data.creatorId ||
         req.params.wallet ||
         req.params.creatorId ||
         req.params.id;
      const identifier = Array.isArray(rawIdentifier)
         ? rawIdentifier[0]
         : String(rawIdentifier);

      const profile = await upsertCreatorProfile(
         identifier,
         body
      );
      return sendSuccess(
         res,
         profile,
         202,
         'Creator profile updated successfully'
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

