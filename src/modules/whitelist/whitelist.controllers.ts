import { AsyncController } from '../../types/auth.types';
import {
   sendSuccess,
   sendValidationError,
   sendNotFound,
} from '../../utils/api-response.utils';
import {
   GetWhitelistStatusQuery,
   GetWhitelistStatusQuerySchema,
} from './whitelist.schemas';
import { getWhitelistStatus, creatorExists } from './whitelist.service';

/**
 * GET /keys/:keyId/whitelist
 * Returns the whitelist status and approval status for a wallet.
 * Public endpoint - no authentication required.
 */
export const httpGetWhitelistStatus: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      const { keyId } = req.params as { keyId: string };
      const { wallet } = req.query;

      if (!keyId) {
         return sendValidationError(res, 'Missing required parameters', [
            { field: 'keyId', message: 'Key ID is required' },
         ]);
      }

      if (!wallet) {
         return sendValidationError(res, 'Missing required parameters', [
            { field: 'wallet', message: 'Wallet address is required' },
         ]);
      }

      // Parse and validate query parameters
      const parsed = GetWhitelistStatusQuerySchema.safeParse({ wallet });
      if (!parsed.success) {
         return sendValidationError(res, 'Invalid query parameters', [
            { field: 'wallet', message: 'Invalid wallet address format' },
         ]);
      }

      const query = parsed.data as GetWhitelistStatusQuery;
      const creatorId = keyId;

      // Verify creator exists
      const exists = await creatorExists(creatorId);
      if (!exists) {
         return sendNotFound(res, 'Creator');
      }

      // Get whitelist status with caching
      const status = await getWhitelistStatus(creatorId, query.wallet);

      return sendSuccess(res, {
         whitelistEnabled: status.whitelistEnabled,
         isApproved: status.isApproved,
      });
   } catch (error) {
      next(error);
   }
};
