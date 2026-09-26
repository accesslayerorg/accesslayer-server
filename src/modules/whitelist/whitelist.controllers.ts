import { AsyncController } from '../../types/auth.types';
import {
   sendSuccess,
   sendValidationError,
   sendNotFound,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   GetWhitelistStatusQuery,
   GetWhitelistStatusQuerySchema,
   AddWhitelistBodySchema,
   RemoveWhitelistParamsSchema,
} from './whitelist.schemas';
import {
   getWhitelistStatus,
   creatorExists,
   resolveCreatorId,
   addWalletsToWhitelist,
   removeWalletFromWhitelist,
   listWhitelist,
} from './whitelist.service';

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

/**
 * POST /keys/:keyId/whitelist
 * Creator-only. Bulk-adds wallets to the key's whitelist.
 */
export const httpAddToWhitelist: AsyncController = async (req, res, next) => {
   try {
      const parsed = AddWhitelistBodySchema.safeParse(req.body);
      if (!parsed.success) {
         return sendValidationError(
            res,
            'Invalid request body',
            zodIssuesToDetails(parsed.error.issues)
         );
      }

      const creatorId = await resolveCreatorId(String(req.params.keyId));
      if (!creatorId) {
         return sendNotFound(res, 'Key');
      }

      const result = await addWalletsToWhitelist(creatorId, parsed.data.wallets);
      return sendSuccess(res, result, result.added.length > 0 ? 201 : 200);
   } catch (error) {
      next(error);
   }
};

/**
 * DELETE /keys/:keyId/whitelist/:wallet
 * Creator-only. Removes a single wallet from the key's whitelist.
 */
export const httpRemoveFromWhitelist: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      const parsed = RemoveWhitelistParamsSchema.safeParse(req.params);
      if (!parsed.success) {
         return sendValidationError(
            res,
            'Invalid path parameters',
            zodIssuesToDetails(parsed.error.issues)
         );
      }

      const creatorId = await resolveCreatorId(parsed.data.keyId);
      if (!creatorId) {
         return sendNotFound(res, 'Key');
      }

      const removed = await removeWalletFromWhitelist(
         creatorId,
         parsed.data.wallet
      );
      if (!removed) {
         return sendNotFound(res, 'Whitelist entry');
      }
      return sendSuccess(res, { removed: true, wallet: parsed.data.wallet });
   } catch (error) {
      next(error);
   }
};

/**
 * GET /keys/:keyId/whitelist
 * Creator-only. Returns the full whitelist synced from on-chain state.
 */
export const httpListWhitelist: AsyncController = async (req, res, next) => {
   try {
      const creatorId = await resolveCreatorId(String(req.params.keyId));
      if (!creatorId) {
         return sendNotFound(res, 'Key');
      }

      const wallets = await listWhitelist(creatorId);
      return sendSuccess(res, { wallets, total: wallets.length });
   } catch (error) {
      next(error);
   }
};
