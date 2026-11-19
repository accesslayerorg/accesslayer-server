// src/modules/trading/nonce.routes.ts
// Endpoints for issuing single-use nonces for signed trade messages (#1194).

import { Router, Request, Response, NextFunction } from 'express';
import { StellarAddressSchema } from '../wallet/wallet.schemas';
import { ErrorCode } from '../../constants/error.constants';
import { sendError } from '../../utils/api-response.utils';
import { issueNonce } from './nonce.service';

const nonceRouter = Router();

/**
 * GET /nonce/:wallet
 * Issues a fresh one-time nonce stored in Redis with TTL for replay protection.
 */
nonceRouter.get(
   '/:wallet',
   async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const walletParam = req.params.wallet;
      const wallet = Array.isArray(walletParam) ? walletParam[0] : walletParam;

      const addressValidation = StellarAddressSchema.safeParse(wallet);
      if (!addressValidation.success) {
         sendError(
            res,
            400,
            ErrorCode.BAD_REQUEST,
            'Invalid Stellar wallet address format',
            addressValidation.error.issues.map(issue => ({
               field: 'wallet',
               message: issue.message,
            }))
         );
         return;
      }

      try {
         const { nonce, expiresIn } = await issueNonce(wallet);

         // Return standard response structure while also including root nonce for client compatibility
         res.status(200).json({
            success: true,
            data: {
               nonce,
               expires_in: expiresIn,
            },
            nonce,
         });
      } catch (error) {
         next(error);
      }
   }
);

export default nonceRouter;
