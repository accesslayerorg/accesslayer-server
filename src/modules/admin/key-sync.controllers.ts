import { AsyncController } from '../../types/auth.types';
import {
   sendSuccess,
   sendValidationError,
   sendCreatorParamNotFound,
} from '../../utils/api-response.utils';
import { AdminRequest } from '../../middlewares/admin-guard.middleware';
import { Response } from 'express';
import { syncKeyState, creatorExists } from './key-sync.service';

/**
 * POST /admin/keys/:keyId/sync
 * Manually sync a key's on-chain state with the database.
 * Requires admin JWT authentication.
 */
export const httpSyncKeyState: AsyncController = async (
   req: AdminRequest,
   res: Response,
   next
) => {
   try {
      const { keyId } = req.params as { keyId: string };

      if (!keyId) {
         return sendValidationError(res, 'Missing required parameters', [
            { field: 'keyId', message: 'Key ID is required' },
         ]);
      }

      // Verify creator exists
      const exists = await creatorExists(keyId);
      if (!exists) {
         return sendCreatorParamNotFound(res);
      }

      // Perform sync within transaction
      const result = await syncKeyState(keyId);

      return sendSuccess(res, {
         creatorId: result.creatorId,
         changedFields: result.changedFields,
         success: result.success,
         timestamp: result.timestamp.toISOString(),
      });
   } catch (error) {
      next(error);
   }
};
