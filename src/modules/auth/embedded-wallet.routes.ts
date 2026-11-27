// src/modules/auth/embedded-wallet.routes.ts
// Embedded wallet signing and export endpoints (#1313).

import { Router, Response } from 'express';
import { z } from 'zod';
import {
   requireJwtAuth,
   AuthenticatedRequest,
} from '../../middlewares/jwt-auth.middleware';
import {
   sendSuccess,
   sendError,
   sendValidationError,
   zodIssuesToDetails,
   ErrorCode,
   ErrorCodeType,
} from '../../utils/api-response.utils';
import {
   signWithEmbeddedWallet,
   requestEmbeddedWalletExportConfirmation,
   exportEmbeddedWallet,
   PasskeyServiceError,
} from './passkey.service';
import { logger } from '../../utils/logger.utils';

const router = Router();

const signSchema = z.object({
   transactionXdr: z.string().min(1),
   amount: z.number().nonnegative(),
   assertionChallengeId: z.string().min(1).optional(),
   assertionResponse: z.record(z.unknown()).optional(),
});

const exportSchema = z.object({
   emailConfirmationCode: z.string().min(4),
   assertionChallengeId: z.string().min(1).optional(),
   assertionResponse: z.record(z.unknown()).optional(),
});

function handleEmbeddedWalletError(
   res: Response,
   error: unknown,
   context: string
): void {
   if (error instanceof PasskeyServiceError) {
      sendError(res, error.statusCode, error.code as ErrorCodeType, error.message);
      return;
   }
   logger.error({ error }, context);
   sendError(res, 500, ErrorCode.INTERNAL_ERROR, context);
}

router.post(
   '/sign',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response) => {
      const parsed = signSchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid embedded wallet sign request',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      try {
         const origin = req.get('origin') ?? undefined;
         const result = await signWithEmbeddedWallet({
            walletAddress: req.user!.wallet,
            transactionXdr: parsed.data.transactionXdr,
            amount: parsed.data.amount,
            assertionChallengeId: parsed.data.assertionChallengeId,
            assertionResponse: parsed.data.assertionResponse as any,
            origin,
         });
         sendSuccess(res, result);
      } catch (error) {
         handleEmbeddedWalletError(
            res,
            error,
            'Failed to sign transaction with embedded wallet'
         );
      }
   }
);

router.post(
   '/export/request-confirmation',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response) => {
      try {
         const result = await requestEmbeddedWalletExportConfirmation({
            walletAddress: req.user!.wallet,
         });
         sendSuccess(res, result);
      } catch (error) {
         handleEmbeddedWalletError(
            res,
            error,
            'Failed to send embedded wallet export confirmation'
         );
      }
   }
);

router.post(
   '/export',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response) => {
      const parsed = exportSchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid embedded wallet export request',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      try {
         const origin = req.get('origin') ?? undefined;
         const result = await exportEmbeddedWallet({
            walletAddress: req.user!.wallet,
            emailConfirmationCode: parsed.data.emailConfirmationCode,
            assertionChallengeId: parsed.data.assertionChallengeId,
            assertionResponse: parsed.data.assertionResponse as any,
            origin,
         });
         sendSuccess(res, result);
      } catch (error) {
         handleEmbeddedWalletError(
            res,
            error,
            'Failed to export embedded wallet'
         );
      }
   }
);

export default router;
