import { Request, Response } from 'express';
import { logger } from '../../utils/logger.utils';
import {
   sendSuccess,
   sendError,
   sendNotFound,
} from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import { followCreator, unfollowCreator } from './follow.service';
import { creatorProfileExists } from './creator-profile.service';

export async function httpFollowCreator(
   req: Request<{ creatorId: string }>,
   res: Response
): Promise<void> {
   try {
      const creatorId = String(req.params.creatorId);
      const walletAddress = (req as any).walletAddress;

      if (!walletAddress) {
         sendError(
            res,
            401,
            ErrorCode.UNAUTHORIZED,
            'Wallet address is required'
         );
         return;
      }

      const exists = await creatorProfileExists(creatorId);
      if (!exists) {
         sendNotFound(res, 'Creator');
         return;
      }

      const result = await followCreator(creatorId, walletAddress);
      const statusCode = result.action === 'followed' ? 201 : 200;
      sendSuccess(res, result, statusCode);
   } catch (error) {
      logger.error(
         {
            type: 'follow_handler_error',
            handler: 'httpFollowCreator',
            error,
         },
         'Error following creator'
      );
      sendError(
         res,
         500,
         ErrorCode.INTERNAL_ERROR,
         'Failed to follow creator'
      );
   }
}

export async function httpUnfollowCreator(
   req: Request<{ creatorId: string }>,
   res: Response
): Promise<void> {
   try {
      const creatorId = String(req.params.creatorId);
      const walletAddress = (req as any).walletAddress;

      if (!walletAddress) {
         sendError(
            res,
            401,
            ErrorCode.UNAUTHORIZED,
            'Wallet address is required'
         );
         return;
      }

      const exists = await creatorProfileExists(creatorId);
      if (!exists) {
         sendNotFound(res, 'Creator');
         return;
      }

      const result = await unfollowCreator(creatorId, walletAddress);
      sendSuccess(res, result, 200);
   } catch (error) {
      logger.error(
         {
            type: 'unfollow_handler_error',
            handler: 'httpUnfollowCreator',
            error,
         },
         'Error unfollowing creator'
      );
      sendError(
         res,
         500,
         ErrorCode.INTERNAL_ERROR,
         'Failed to unfollow creator'
      );
   }
}
