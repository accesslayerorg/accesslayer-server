// src/modules/contracts/contract-error.utils.ts
// Error classification for the Soroban contract interaction service (#899).
//
// The retry loop only re-attempts submissions classified as `transient`.
// Anything classified as `user` (bad signature, insufficient funds, contract
// rejecting the operation, malformed envelope) is returned to the caller
// immediately — retrying cannot change the outcome and would burn fees.

import { logger } from '../../utils/logger.utils';
import type { ContractErrorKind } from './contract.types';

/**
 * Error thrown by `submitContractCall` when a submission ultimately fails.
 * The `kind` field drives downstream handling: `user` errors surface as 4xx
 * responses, `transient` exhaustion surfaces as 503.
 */
export class ContractSubmitError extends Error {
   constructor(
      public readonly kind: ContractErrorKind,
      message: string,
      public readonly attempts: number,
      public readonly txHash: string | null = null
   ) {
      super(message);
      this.name = 'ContractSubmitError';
   }
}

/**
 * Error thrown when a transaction was accepted for submission but did not
 * reach a ledger within the polling window. Distinct kind so callers can
 * tell "we do not know yet" apart from a hard failure.
 */
export class ContractConfirmationTimeoutError extends Error {
   constructor(
      public readonly txHash: string,
      public readonly attempts: number
   ) {
      super(
         `Transaction ${txHash} was not included in a ledger within the polling window`
      );
      this.name = 'ContractConfirmationTimeoutError';
   }
}

/** Ordered list of markers that indicate a permanent (user) failure. */
const USER_ERROR_MARKERS = [
   'tx_bad_auth', // bad/insufficient signatures
   'tx_bad_seq', // stale sequence number supplied by the caller
   'tx_insufficient_balance',
   'tx_insufficient_fee',
   'tx_no_source_account',
   'tx_malformed',
   'tx_too_late', // expired time bounds — caller must rebuild
   'tx_too_early',
   'insufficient_funds', // contract-level check
   'unauthorized', // contract auth failure
   'not_found',
   'invalid',
   'expired',
   'reverted', // contract execution rejected the operation
];

/** Ordered list of markers that indicate a retryable (transient) failure. */
const TRANSIENT_ERROR_MARKERS = [
   'timeout',
   'timed out',
   'temporarily',
   'unavailable',
   'rate limit',
   'too many requests',
   'internal error',
   'try again',
   ' aborted', // e.g. "tx submission aborted" — node rejected due to load
   'connection',
   'network',
   'econnrefused',
   'econnreset',
   'enotfound',
   'etimedout',
   '502',
   '503',
   '504',
];

/**
 * Strip XDR/base64 noise so substring matching against the message is
 * meaningful even when the node embeds opaque blobs in the error text.
 */
function sanitizeMessage(message: string): string {
   return message
      .replace(/[A-Za-z0-9+/=]{40,}/g, '[xdr]')
      .toLowerCase();
}

/**
 * Classify an unknown error from the submit path as `user` (no retry) or
 * `transient` (retry). Defaults to `transient` for unrecognised transport
 * failures — the conservative choice for RPC blips — except when the error
 * is a validation-shaped Error with no network semantics.
 */
export function classifyContractError(error: unknown): ContractErrorKind {
   if (error instanceof Error) {
      // Explicitly classified errors from our own client carry a code; the
      // JSON-RPC method-level errors from Soroban are app-level rejections
      // of the submission itself (e.g. -32602 invalid params on malformed
      // XDR), which retrying cannot fix.
      if (error.name === 'SorobanRpcMethodError') {
         return 'user';
      }

      const message = sanitizeMessage(error.message);
      if (USER_ERROR_MARKERS.some(marker => message.includes(marker))) {
         return 'user';
      }
      if (TRANSIENT_ERROR_MARKERS.some(marker => message.includes(marker))) {
         return 'transient';
      }

      // TypeError/AbortError from fetch — network-level, retryable.
      if (
         error.name === 'TypeError' ||
         error.name === 'AbortError' ||
         error.name === 'SorobanRpcHttpError'
      ) {
         return 'transient';
      }
   }

   logger.debug(
      { error: error instanceof Error ? error.message : String(error) },
      'Unclassified contract error defaulted to transient'
   );
   return 'transient';
}
