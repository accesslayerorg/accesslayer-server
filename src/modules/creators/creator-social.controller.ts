import { AsyncController } from '../../types/auth.types';
import { getCreatorSocial } from './creator-social.service';
import { sendSuccess, sendNotFound } from '../../utils/api-response.utils';
import { attachTimestampHeader } from '../../utils/timestamp-headers.utils';

/**
 * Controller for GET /api/v1/creators/:wallet/social
 *
 * Returns the social metadata (display name, bio, avatar URL, social links)
 * synced from SocialMetadataUpdated events for the creator identified by the
 * given Stellar wallet address (creator id / handle accepted as a fallback).
 *
 * - Returns 404 if no creator matches the identifier.
 * - Returns synced=false with null values (not 404) when the creator exists
 *   but no social metadata event has been indexed yet.
 */
export const httpGetCreatorSocial: AsyncController = async (req, res, next) => {
   try {
      const rawWallet = req.params.wallet;
      const walletOrCreatorId = Array.isArray(rawWallet)
         ? rawWallet[0]
         : rawWallet;

      const social = await getCreatorSocial(String(walletOrCreatorId));
      if (!social) {
         return sendNotFound(res, 'Creator');
      }

      attachTimestampHeader(res);
      sendSuccess(
         res,
         social,
         200,
         'Creator social metadata retrieved successfully'
      );
   } catch (error) {
      next(error);
   }
};
