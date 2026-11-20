// src/modules/nonce/nonce.controllers.ts
// HTTP controllers for nonce management and replay protection (#1039).

import type { Request, Response, NextFunction } from 'express';
import { GetNonceQuerySchema, ConsumeNonceBodySchema } from './nonce.schemas';
import {
   getWalletNonce,
   consumeWalletNonce,
   NonceAlreadyConsumedError,
   NonceMismatchError,
} from './nonce.service';
import {
   sendSuccess,
   sendValidationError,
   sendConflict,
   sendError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';

/**
 * GET /api/v1/nonce?wallet=
 * Returns the current active nonce for a wallet (from contract, cached with short TTL).
 */
export async function httpGetWalletNonce(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const parsed = GetNonceQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid query parameters',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      const info = await getWalletNonce(parsed.data.wallet);
      sendSuccess(res, info);
   } catch (error) {
      next(error);
   }
}

/**
 * POST /api/v1/nonce/consume
 * Records nonce consumption after an action executes.
 * Immediately rejects already-consumed nonces with HTTP 409 Conflict.
 */
export async function httpConsumeWalletNonce(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const parsed = ConsumeNonceBodySchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid request body',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      const result = await consumeWalletNonce(
         parsed.data.wallet,
         parsed.data.nonce,
         parsed.data.action
      );
      sendSuccess(res, result, 200, 'Nonce consumed successfully');
   } catch (error) {
      if (error instanceof NonceAlreadyConsumedError) {
         sendConflict(res, error.message);
         return;
      }
      if (error instanceof NonceMismatchError) {
         sendError(res, 400, ErrorCode.BAD_REQUEST, error.message);
         return;
      }
      next(error);
   }
}
