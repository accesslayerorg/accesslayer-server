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
   CheckWhitelistBodySchema,
} from './whitelist.schemas';
import {
   getWhitelistStatus,
   creatorExists,
   resolveCreatorId,
   addWalletsToWhitelist,
   removeWalletFromWhitelist,
   listWhitelist,
   getBulkWhitelistStatus,
} from './whitelist.service';

/**
 * GET /keys/:key_id/whitelist/:wallet
 * (also supports GET /keys/:keyId/whitelist?wallet=...)
 * Returns whitelist status and wallet approval status.
 * Public endpoint - no authentication required.
 */
export const httpGetWhitelistStatus: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      const keyId = (req.params.key_id ?? req.params.keyId) as string;
      const wallet = req.params.wallet ?? req.query.wallet;

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

      // Parse and validate query/path parameters
      const parsed = GetWhitelistStatusQuerySchema.safeParse({ wallet });
      if (!parsed.success) {
         return sendValidationError(res, 'Invalid query parameters', [
            { field: 'wallet', message: 'Invalid wallet address format' },
         ]);
      }

      const query = parsed.data as GetWhitelistStatusQuery;

      // Verify creator / key exists
      const exists = await creatorExists(keyId);
      if (!exists) {
         return sendNotFound(res, 'Creator');
      }

      const resolvedCreatorId = (await resolveCreatorId(keyId)) ?? keyId;

      // Get whitelist status with 30s caching
      const status = await getWhitelistStatus(resolvedCreatorId, query.wallet);

      return sendSuccess(res, {
         is_whitelisted: status.is_whitelisted,
         whitelist_mode_enabled: status.whitelist_mode_enabled,
         whitelistEnabled: status.whitelistEnabled,
         isApproved: status.isApproved,
      });
   } catch (error) {
      next(error);
   }
};

/**
 * POST /keys/:key_id/whitelist/check
 * Bulk check endpoint returning status for all submitted wallets.
 * Public endpoint - no authentication required.
 */
export const httpCheckWhitelistBulk: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      const keyId = (req.params.key_id ?? req.params.keyId) as string;

      if (!keyId) {
         return sendValidationError(res, 'Missing required parameters', [
            { field: 'keyId', message: 'Key ID is required' },
         ]);
      }

      const parsed = CheckWhitelistBodySchema.safeParse(req.body);
      if (!parsed.success) {
         return sendValidationError(
            res,
            'Invalid request body',
            zodIssuesToDetails(parsed.error.issues)
         );
      }

      const exists = await creatorExists(keyId);
      if (!exists) {
         return sendNotFound(res, 'Key');
      }

      const resolvedCreatorId = (await resolveCreatorId(keyId)) ?? keyId;

      const bulkResult = await getBulkWhitelistStatus(
         resolvedCreatorId,
         parsed.data.wallets
      );

      return sendSuccess(res, bulkResult);
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
      const keyId = (req.params.key_id ?? req.params.keyId) as string;
      const parsed = AddWhitelistBodySchema.safeParse(req.body);
      if (!parsed.success) {
         return sendValidationError(
            res,
            'Invalid request body',
            zodIssuesToDetails(parsed.error.issues)
         );
      }

      const creatorId = await resolveCreatorId(keyId);
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
      const keyId = (req.params.key_id ?? req.params.keyId) as string;
      const parsed = RemoveWhitelistParamsSchema.safeParse({
         keyId,
         wallet: req.params.wallet,
      });
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
      const keyId = (req.params.key_id ?? req.params.keyId) as string;
      const creatorId = await resolveCreatorId(keyId);
      if (!creatorId) {
         return sendNotFound(res, 'Key');
      }

      const wallets = await listWhitelist(creatorId);
      return sendSuccess(res, { wallets, total: wallets.length });
   } catch (error) {
      next(error);
   }
};
