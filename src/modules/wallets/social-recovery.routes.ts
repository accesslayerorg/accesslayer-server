// src/modules/wallets/social-recovery.routes.ts
import { Router } from 'express';
import { sendSuccess, sendValidationError } from '../../utils/api-response.utils';
import {
   getGuardianRequests,
   getRecoveryStatus,
} from './social-recovery.service';

const socialRecoveryRouter = Router();

/**
 * GET /api/v1/wallets/:address/recovery?viewer=<address>
 *
 * Returns the guardian configuration for `:address`, plus any pending
 * recovery request with its approval count and earliest execution ledger
 * (#1350). Guardian details are only revealed to the wallet owner and
 * named guardians; other callers see counts only.
 */
socialRecoveryRouter.get('/:address/recovery', async (req, res, next) => {
   try {
      const address = String(req.params.address);
      if (!address) {
         return sendValidationError(res, 'Invalid address');
      }
      const viewer = typeof req.query.viewer === 'string' ? req.query.viewer : undefined;
      const status = await getRecoveryStatus(address, viewer);
      return sendSuccess(res, status);
   } catch (error) {
      next(error);
   }
});

const guardianRequestsRouter = Router();

/**
 * GET /api/v1/guardians/:address/requests
 *
 * Lists pending recovery requests that name `:address` as a guardian so
 * the guardian UI can show pending approvals due (#1350).
 */
guardianRequestsRouter.get('/:address/requests', async (req, res, next) => {
   try {
      const address = String(req.params.address);
      if (!address) {
         return sendValidationError(res, 'Invalid address');
      }
      return sendSuccess(res, await getGuardianRequests(address));
   } catch (error) {
      next(error);
   }
});

export { socialRecoveryRouter, guardianRequestsRouter };
