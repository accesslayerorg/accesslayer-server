// src/modules/creators/creator-public-profile.controller.ts
// HTTP controllers for the public creator profile endpoints (#1009).

import { AsyncController } from '../../types/auth.types';
import {
   sendSuccess,
   sendNotFound,
   sendValidationError,
} from '../../utils/api-response.utils';
import { attachTimestampHeader } from '../../utils/timestamp-headers.utils';
import {
   getCreatorPublicProfile,
   getCreatorDeployedKeys,
} from './creator-public-profile.service';

const StellarWalletAddressRegex = /^G[A-Z2-7]{55}$/;

/**
 * GET /api/v1/creators/:wallet
 *
 * Returns the public profile for a creator wallet with memberSince, totalKeys,
 * totalVolume, avgRating, and stats aggregated across all their deployed keys.
 * Verified badge derived from KYC status. Returns 404 for unregistered wallets.
 */
export const httpGetCreatorPublicProfile: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      const rawWallet = req.params.wallet ?? req.params.id;
      const wallet = Array.isArray(rawWallet) ? rawWallet[0] : rawWallet;

      if (!wallet || !StellarWalletAddressRegex.test(wallet)) {
         return sendValidationError(res, 'Invalid wallet address', [
            { field: 'wallet', message: 'A valid Stellar wallet address is required' },
         ]);
      }

      const profile = await getCreatorPublicProfile(wallet);
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
 * GET /api/v1/creators/:wallet/keys
 *
 * Returns a cursor-paginated list of deployed keys for a creator wallet in
 * deployment order with status and price.
 */
export const httpGetCreatorIssuedKeys: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      const rawWallet = req.params.wallet ?? req.params.id;
      const wallet = Array.isArray(rawWallet) ? rawWallet[0] : rawWallet;

      if (!wallet || !StellarWalletAddressRegex.test(wallet)) {
         return sendValidationError(res, 'Invalid wallet address', [
            { field: 'wallet', message: 'A valid Stellar wallet address is required' },
         ]);
      }

      const rawLimit = req.query.limit;
      const rawCursor = req.query.cursor;

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

      const page = await getCreatorDeployedKeys(
         wallet,
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
