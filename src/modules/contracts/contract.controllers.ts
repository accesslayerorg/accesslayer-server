// src/modules/contracts/contract.controllers.ts
// HTTP boundary for the centralised Soroban contract interaction service (#899).
//
// The controller only serializes/deserializes; all submission, retry, and
// tracking logic lives in contract.service.ts.

import { AsyncController } from '../../types/auth.types';
import {
   sendSuccess,
   sendValidationError,
   sendError,
   zodIssuesToDetails,
   ErrorCode,
} from '../../utils/api-response.utils';
import { logger } from '../../utils/logger.utils';
import { SubmitContractCallSchema } from './contract.schemas';
import {
   submitContractCall,
   ContractSubmitError,
} from './contract.service';

/**
 * POST /contracts/call
 *
 * Route a signed Soroban transaction through the centralised submission
 * pipeline. Returns the terminal submission result (CONFIRMED or FAILED);
 * user errors surface as 400, transient exhaustion as 503.
 */
export const httpSubmitContractCall: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      const parsed = SubmitContractCallSchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid contract call request',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      const { operation, submitter_wallet, transaction_xdr } = parsed.data;

      const result = await submitContractCall(
         {
            operation,
            submitterWallet: submitter_wallet,
            transactionXdr: transaction_xdr,
         },
         {} // default deps: real Soroban transport + env-configured timing
      );

      sendSuccess(res, result);
   } catch (err) {
      if (err instanceof ContractSubmitError) {
         logger.info(
            {
               operation: 'contract_call_rejected',
               error_kind: err.kind,
               attempts: err.attempts,
            },
            'Contract call rejected'
         );

         if (err.kind === 'user') {
            sendError(
               res,
               400,
               ErrorCode.BAD_REQUEST,
               err.message
            );
            return;
         }

         // Transient exhaustion — the RPC was unreachable/overloaded for
         // every attempt. Surface 503 so clients back off and retry later.
         sendError(
            res,
            503,
            ErrorCode.RATE_LIMIT,
            err.message
         );
         return;
      }
      next(err);
   }
};
