import { AsyncController } from '../../types/auth.types';
import {
   follow,
   unfollow,
   getFollowerCount,
} from './follower.service';
import { sendSuccess, sendValidationError } from '../../utils/api-response.utils';

function getParamString(val: string | string[] | undefined): string | undefined {
   if (!val) return undefined;
   return Array.isArray(val) ? val[0] : val;
}

export const httpFollow: AsyncController = async (req, res, next) => {
   try {
      const creatorWallet = getParamString(req.params.creatorWallet);
      const followerWallet = req.body?.followerWallet || req.jwtPayload?.walletAddress;

      if (!creatorWallet || !followerWallet) {
         sendValidationError(res, 'creatorWallet param and followerWallet body/token are required');
         return;
      }

      const result = await follow(followerWallet, creatorWallet);
      sendSuccess(res, result);
   } catch (err) {
      next(err);
   }
};

export const httpUnfollow: AsyncController = async (req, res, next) => {
   try {
      const creatorWallet = getParamString(req.params.creatorWallet);
      const followerWallet = req.body?.followerWallet || req.jwtPayload?.walletAddress;

      if (!creatorWallet || !followerWallet) {
         sendValidationError(res, 'creatorWallet param and followerWallet body/token are required');
         return;
      }

      const result = await unfollow(followerWallet, creatorWallet);
      sendSuccess(res, result);
   } catch (err) {
      next(err);
   }
};

export const httpGetFollowerCount: AsyncController = async (req, res, next) => {
   try {
      const creatorWallet = getParamString(req.params.creatorWallet);
      if (!creatorWallet) {
         sendValidationError(res, 'creatorWallet parameter is required');
         return;
      }

      const count = await getFollowerCount(creatorWallet);
      sendSuccess(res, { creatorWallet, count });
   } catch (err) {
      next(err);
   }
};
