// src/clients/soroban.client.ts
// Soroban JSON-RPC client for transaction submission and status polling (#899).
//
// All Soroban RPC traffic for the contract interaction service goes through
// this module so request logging, timeouts, and error normalization are
// applied consistently (mirrors clients/horizon.client.ts).
//
// The client is transport-agnostic: endpoints accept an injectable `postJson`
// implementation so unit tests can stub the network without extra mocking
// libraries.

import { logger } from '../utils/logger.utils';
import { envConfig } from '../config';

/** Default JSON-RPC POST transport used in production. */
async function defaultPostJson(url: string, body: unknown): Promise<unknown> {
   const controller = new AbortController();
   const timeout = setTimeout(
      () => controller.abort(),
      envConfig.DB_QUERY_TIMEOUT_MS
   );

   try {
      const response = await fetch(url, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify(body),
         signal: controller.signal,
      });

      if (!response.ok) {
         throw new SorobanRpcHttpError(
            response.status,
            response.statusText || 'HTTP error'
         );
      }

      return (await response.json()) as unknown;
   } finally {
      clearTimeout(timeout);
   }
}

export type SorobanPostJson = (
   url: string,
   body: unknown
) => Promise<unknown>;

/** Expose the default transport for callers that want to bind clients to it. */
export const defaultSorobanTransport: SorobanPostJson = defaultPostJson;

/** HTTP-level failure from the Soroban RPC endpoint (non-2xx response). */
export class SorobanRpcHttpError extends Error {
   constructor(
      public readonly status: number,
      public readonly statusText: string
   ) {
      super(`Soroban RPC HTTP ${status}: ${statusText}`);
      this.name = 'SorobanRpcHttpError';
   }
}

/** JSON-RPC application error envelope returned by the Soroban node. */
export class SorobanRpcMethodError extends Error {
   constructor(
      public readonly code: number,
      message: string
   ) {
      super(`Soroban RPC error ${code}: ${message}`);
      this.name = 'SorobanRpcMethodError';
   }
}

/** Result of the `sendTransaction` JSON-RPC method. */
export interface SendTransactionResult {
   /** Present when the node accepted the transaction into its queue. */
   hash?: string;
   status: string;
   /** Base64 XDR error result — set when status is "ERROR". */
   errorResultXdr?: string;
   latestLedger?: number;
}

/** Result of the `getTransaction` JSON-RPC method. */
export interface GetTransactionResult {
   status: 'SUCCESS' | 'NOT_FOUND' | 'FAILED';
   latestLedger?: number;
   /** Ledger sequence that included the transaction (when not NOT_FOUND). */
   ledger?: number;
   /** Base64 XDR result meta/metaV3 of the processed transaction. */
   resultXdr?: string;
}

/** Standard JSON-RPC 2.0 envelope used by Soroban nodes. */
interface JsonRpcEnvelope {
   result?: unknown;
   error?: { code: number; message: string };
}

async function callRpc<T>(
   method: string,
   params: unknown,
   postJson: SorobanPostJson
): Promise<T> {
   const url = envConfig.STELLAR_SOROBAN_RPC_URL;
   const body = { jsonrpc: '2.0', id: '1', method, params };

   let envelope: unknown;
   try {
      envelope = await postJson(url, body);
   } catch (error) {
      logger.warn(
         { method, error: (error as Error).message },
         'Soroban RPC request failed'
      );
      throw error;
   }

   const { result, error } = (envelope ?? {}) as JsonRpcEnvelope;
   if (error) {
      throw new SorobanRpcMethodError(error.code, error.message);
   }

   return result as T;
}

/**
 * Submit a signed transaction envelope to the Soroban network.
 *
 * Throws {@link SorobanRpcHttpError} / {@link SorobanRpcMethodError} on
 * transport or application errors so the caller can classify them as
 * transient and retry (see contract-error.utils.ts).
 *
 * @param transactionXdr - Base64 XDR of the signed transaction envelope.
 * @param postJson - Injectable transport (tests pass a stub).
 */
export async function sendTransaction(
   transactionXdr: string,
   postJson: SorobanPostJson = defaultPostJson
): Promise<SendTransactionResult> {
   const result = await callRpc<SendTransactionResult>(
      'sendTransaction',
      { transaction: transactionXdr },
      postJson
   );

   logger.debug(
      {
         tx_hash: result.hash,
         status: result.status,
      },
      'Soroban sendTransaction response'
   );

   return result;
}

/**
 * Poll the status of a previously submitted transaction by hash.
 *
 * Returns the raw node status; "NOT_FOUND" simply means the transaction has
 * not been included in a ledger yet — the poller keeps polling until its
 * deadline (see confirmation-poller.utils.ts).
 *
 * @param hash - Transaction hash (hex) returned by sendTransaction.
 * @param postJson - Injectable transport (tests pass a stub).
 */
export async function getTransaction(
   hash: string,
   postJson: SorobanPostJson = defaultPostJson
): Promise<GetTransactionResult> {
   return callRpc<GetTransactionResult>(
      'getTransaction',
      { hash },
      postJson
   );
}
