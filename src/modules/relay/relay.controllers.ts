// src/modules/relay/relay.controllers.ts
// HTTP controllers for the gasless meta-transaction relay flow (#1088).

import type { Request, Response, NextFunction } from 'express';
import { RelaySubmitBodySchema, RelayNonceParamsSchema } from './relay.schemas';
import {
   reserveWalletNonce,
   submitRelayTransaction,
   reservationToResponse,
} from './relay.service';
import {
   sendSuccess,
   sendError,
   sendValidationError,
   sendConflict,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import {
   RelayNonceExpiredError,
   RelayNonceNotReservedError,
   RelayNonceAlreadyUsedError,
   RelayInvalidSignatureError,
   RelaySubmissionError,
} from './relay.errors';
import type { RelaySigner, RelaySubmitter } from './relay.types';
import type { RelaySubmitBody } from './relay.schemas';
import { defaultSigner, defaultSubmitter } from './relay.service';

/**
 * GET /relay/nonce/:wallet
 * Returns the next unused nonce for the wallet and reserves it for 5 minutes.
 */
export async function httpGetRelayNonce(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const parsed = RelayNonceParamsSchema.safeParse(req.params);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid wallet parameter',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      const { wallet } = parsed.data;
      const reservation = await reserveWalletNonce(wallet);
      sendSuccess(res, reservationToResponse(reservation));
   } catch (error) {
      next(error);
   }
}

/**
 * POST /relay/submit
 * Accepts {wallet, nonce, signature, tx_params}, validates the nonce
 * reservation and signature, then submits the transaction on-chain.
 * Returns the tx_hash on success.
 *
 * `signer` and `submitter` default to the production implementations but can
 * be injected for testing.
 */
export async function httpSubmitRelayTransaction(
   req: Request,
   res: Response,
   next: NextFunction,
   signer: RelaySigner = defaultSigner,
   submitter: RelaySubmitter = defaultSubmitter
): Promise<void> {
   try {
      const parsed = RelaySubmitBodySchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid request body',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      const data = parsed.data as unknown as RelaySubmitBody;
      const result = await submitRelayTransaction(
         data.wallet,
         data.nonce,
         data.signature,
         data.tx_params,
         signer,
         submitter
      );

      sendSuccess(
         res,
         {
            wallet: result.wallet,
            nonce: result.nonce,
            txHash: result.txHash,
         },
         200,
         'Transaction relayed successfully'
      );
   } catch (error) {
      if (error instanceof RelayNonceNotReservedError) {
         sendError(res, 404, ErrorCode.NOT_FOUND, error.message);
         return;
      }
      if (error instanceof RelayNonceExpiredError) {
         sendError(res, 410, ErrorCode.GONE, error.message);
         return;
      }
      if (error instanceof RelayNonceAlreadyUsedError) {
         sendConflict(res, error.message);
         return;
      }
      if (error instanceof RelayInvalidSignatureError) {
         sendError(res, 400, ErrorCode.VALIDATION_ERROR, error.message);
         return;
      }
      if (error instanceof RelaySubmissionError) {
         sendError(res, 502, ErrorCode.SERVICE_UNAVAILABLE, error.message);
         return;
      }
      next(error);
   }
}
