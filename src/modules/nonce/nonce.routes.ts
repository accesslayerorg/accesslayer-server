import { Router, Request, Response, NextFunction } from 'express';
import {
   ConsumeNonceBodySchema,
   GetNonceQuerySchema,
} from './nonce.schemas';
import {
   consumeWalletNonce,
   getWalletNonce,
   NonceAlreadyConsumedError,
   NonceMismatchError,
} from './nonce.service';
import {
   sendConflict,
   sendError,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
   ErrorCode,
} from '../../utils/api-response.utils';

const nonceRouter = Router();

/**
 * GET /api/v1/nonce?wallet=
 * Returns the current nonce for a wallet from the contract (with short TTL cache).
 */
nonceRouter.get(
   '/',
   async (req: Request, res: Response, next: NextFunction) => {
      const parsed = GetNonceQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid wallet query parameter',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      try {
         const info = await getWalletNonce(parsed.data.wallet);
         sendSuccess(res, info);
      } catch (error) {
         next(error);
      }
   }
);

/**
 * POST /api/v1/nonce/consume
 * Records single-use nonce consumption after a signed action executes.
 * Returns 409 immediately if the nonce was already consumed.
 */
nonceRouter.post(
   '/consume',
   async (req: Request, res: Response, next: NextFunction) => {
      const parsed = ConsumeNonceBodySchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid nonce consume payload',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      try {
         const result = await consumeWalletNonce(
            parsed.data.wallet,
            parsed.data.nonce,
            parsed.data.action
         );
         sendSuccess(res, result, 200, 'Nonce consumed');
      } catch (error) {
         if (error instanceof NonceAlreadyConsumedError) {
            sendConflict(res, error.message);
            return;
         }
         if (error instanceof NonceMismatchError) {
            sendError(res, 409, ErrorCode.CONFLICT, error.message);
            return;
         }
         next(error);
      }
   }
);

export default nonceRouter;
