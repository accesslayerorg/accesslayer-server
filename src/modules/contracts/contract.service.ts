// src/modules/contracts/contract.service.ts
// Centralised Soroban contract interaction service (#899).
//
// Every on-chain contract call the server submits must be routed through
// `submitContractCall`. The service:
//
//  1. submits the signed transaction envelope to the Soroban RPC,
//     retrying transient failures up to SOROBAN_SUBMIT_MAX_ATTEMPTS with
//     exponential backoff + jitter (user errors return immediately),
//  2. persists the transaction hash (ContractTransaction, status PENDING)
//     as soon as the node accepts a submission,
//  3. polls getTransaction until the transaction is included in a ledger,
//  4. updates the row to CONFIRMED/FAILED and emits a
//     `contract_tx_confirmed` / `contract_tx_failed` event for downstream
//     handling.
//
// Transport, clock, and delay are injectable so the whole flow is testable
// with fake timers and no network.

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { envConfig } from '../../config';
import { computeRetryDelay } from '../../utils/retry-delay.utils';
import {
   defaultSorobanTransport,
   getTransaction,
   sendTransaction,
   type SorobanPostJson,
} from '../../clients/soroban.client';
import {
   pollForConfirmation,
   type TransactionStatusClient,
} from './confirmation-poller.utils';
import {
   classifyContractError,
   ContractSubmitError,
} from './contract-error.utils';
import {
   emitContractTxConfirmed,
   emitContractTxFailed,
} from './contract-events.utils';
import type {
   ContractOperation,
   ContractSubmissionResult,
   SubmitContractCallInput,
} from './contract.types';

export {
   ContractSubmitError,
   ContractConfirmationTimeoutError,
} from './contract-error.utils';

/** Minimal submit surface the service depends on; injectable for tests. */
export interface SubmitClient {
   sendTransaction(
      transactionXdr: string
   ): Promise<{ hash?: string; status: string; errorResultXdr?: string }>;
}

/** Minimal status surface used during confirmation polling. */
export type ServiceStatusClient = TransactionStatusClient;

export interface ServiceDeps {
   /**
    * JSON-RPC transport used to build the default submit/status clients.
    * Omit to use the real fetch-based Soroban transport. Tests inject a stub
    * here or override the clients directly below.
    */
   postJson?: SorobanPostJson;
   /** Submit client override; defaults to the real RPC-bound client. */
   submitClient?: SubmitClient;
   /** Status client for confirmation polling; defaults to the real RPC. */
   statusClient?: ServiceStatusClient;
   /** Delay implementation; defaults to a real setTimeout. */
   delay?: (ms: number) => Promise<void>;
   /** Clock; injectable for tests. */
   now?: () => number;
   /** Override poll interval/timeout (ms); defaults from env config. */
   pollIntervalMs?: number;
   pollTimeoutMs?: number;
}

const defaultDelay = (ms: number): Promise<void> =>
   new Promise(resolve => setTimeout(resolve, ms));

/** Build the production submit client bound to the Soroban RPC transport. */
export function makeDefaultSubmitClient(
   postJson: SorobanPostJson
): SubmitClient {
   return {
      sendTransaction: (transactionXdr: string) =>
         sendTransaction(transactionXdr, postJson),
   };
}

/** Default status client bound to the real Soroban RPC. */
export function makeDefaultStatusClient(
   postJson: SorobanPostJson
): ServiceStatusClient {
   return {
      getTransaction: (hash: string) => getTransaction(hash, postJson),
   };
}

/**
 * Submit one attempt, mapping node-level rejections into Errors whose
 * message carries the classifyable markers.
 */
async function submitOnce(
   client: SubmitClient,
   transactionXdr: string
): Promise<{ hash: string }> {
   const result = await client.sendTransaction(transactionXdr);

   // Pending/duplicate-status means the node accepted the envelope and
   // returned a hash; ERROR means the submission itself was rejected.
   if (result.hash && result.status !== 'ERROR') {
      return { hash: result.hash };
   }

   const detail = result.errorResultXdr
      ? `submission rejected: ${result.errorResultXdr}`
      : 'submission rejected: no transaction hash returned';
   throw new Error(`tx_failed ${detail}`);
}

/**
 * Persist the tracking row as soon as the node returns a hash. Failures
 * here are logged but do not abort the submission flow — the hash is still
 * returned to the caller and events still fire.
 */
async function recordPending(
   txHash: string,
   operation: ContractOperation,
   submitterWallet: string,
   attempts: number
): Promise<void> {
   try {
      await prisma.contractTransaction.create({
         data: {
            txHash,
            operation,
            submitterWallet,
            status: 'PENDING',
            attempts,
         },
      });
   } catch (error) {
      // Unique-violation on txHash means a prior identical submission is
      // already tracked (e.g. duplicate submit after a timeout); the row
      // exists, so nothing to do.
      logger.warn(
         { tx_hash: txHash, operation, error: (error as Error).message },
         'Failed to record pending contract transaction'
      );
   }
}

/**
 * Route a signed contract transaction through the centralised submission
 * pipeline. See module docs for the full flow.
 *
 * @throws {ContractSubmitError} when submission ultimately fails. `kind`
 *         is `user` for immediate failures and `transient` when retries
 *         were exhausted.
 */
export async function submitContractCall(
   input: SubmitContractCallInput,
   deps: ServiceDeps
): Promise<ContractSubmissionResult> {
   const {
      postJson,
      submitClient = makeDefaultSubmitClient(
         postJson ?? defaultSorobanTransport
      ),
      statusClient = makeDefaultStatusClient(
         postJson ?? defaultSorobanTransport
      ),
      delay = defaultDelay,
      now = Date.now,
      pollIntervalMs = envConfig.SOROBAN_POLL_INTERVAL_MS,
      pollTimeoutMs = envConfig.SOROBAN_POLL_TIMEOUT_MS,
   } = deps;

   const maxAttempts = envConfig.SOROBAN_SUBMIT_MAX_ATTEMPTS;
   const baseDelayMs = envConfig.SOROBAN_SUBMIT_BASE_DELAY_MS;
   const maxDelayMs = envConfig.SOROBAN_SUBMIT_MAX_DELAY_MS;

   // ── 1. Submit with retry ────────────────────────────────────────────
   let attempts = 0;
   let txHash: string | null = null;
   let lastError: Error | null = null;

   while (attempts < maxAttempts) {
      attempts += 1;
      try {
         const { hash } = await submitOnce(submitClient, input.transactionXdr);
         txHash = hash;
         break;
      } catch (error) {
         lastError = error instanceof Error ? error : new Error(String(error));
         const kind = classifyContractError(lastError);

         logger.warn(
            {
               operation: input.operation,
               submitter_wallet: input.submitterWallet,
               attempt: attempts,
               max_attempts: maxAttempts,
               error_kind: kind,
               error: lastError.message,
            },
            'Contract submission attempt failed'
         );

         // User errors are terminal — return immediately without retry.
         if (kind === 'user') {
            emitContractTxFailed({
               operation: input.operation,
               submitterWallet: input.submitterWallet,
               txHash: null,
               errorKind: 'user',
               lastError: lastError.message,
               attempts,
            });
            throw new ContractSubmitError(
               'user',
               lastError.message,
               attempts,
               null
            );
         }

         if (attempts < maxAttempts) {
            const waitMs = computeRetryDelay(
               attempts - 1,
               baseDelayMs,
               maxDelayMs
            );
            logger.info(
               {
                  operation: input.operation,
                  attempt: attempts,
                  backoff_delay_ms: waitMs,
               },
               'Retrying contract submission after backoff'
            );
            await delay(waitMs);
         }
      }
   }

   // All retries exhausted on transient errors.
   if (!txHash) {
      const message = lastError?.message ?? 'unknown submission error';
      emitContractTxFailed({
         operation: input.operation,
         submitterWallet: input.submitterWallet,
         txHash: null,
         errorKind: 'transient',
         lastError: message,
         attempts,
      });
      throw new ContractSubmitError('transient', message, attempts, null);
   }

   // ── 2. Track the transaction hash ───────────────────────────────────
   await recordPending(
      txHash,
      input.operation,
      input.submitterWallet,
      attempts
   );

   // ── 3. Poll until ledger inclusion ──────────────────────────────────
   const outcome = await pollForConfirmation(txHash, {
      statusClient,
      intervalMs: pollIntervalMs,
      timeoutMs: pollTimeoutMs,
      delay,
      now,
   });

   // ── 4. Persist resolution + emit events ─────────────────────────────
   if (outcome?.status === 'SUCCESS') {
      try {
         await prisma.contractTransaction.update({
            where: { txHash },
            data: {
               status: 'CONFIRMED',
               ledger: outcome.ledger,
               resultXdr: outcome.resultXdr ?? null,
               lastError: null,
               errorKind: null,
            },
         });
      } catch (error) {
         logger.error(
            { tx_hash: txHash, error: (error as Error).message },
            'Failed to persist CONFIRMED status'
         );
      }

      emitContractTxConfirmed({
         operation: input.operation,
         submitterWallet: input.submitterWallet,
         txHash,
         ledger: outcome.ledger,
         resultXdr: outcome.resultXdr,
         attempts,
      });

      return {
         status: 'CONFIRMED',
         txHash,
         ledger: outcome.ledger,
         resultXdr: outcome.resultXdr,
         attempts,
      };
   }

   const failureMessage =
      outcome === null
         ? `Confirmation not observed within ${pollTimeoutMs}ms`
         : outcome.lastError || 'Transaction failed on-chain';

   try {
      await prisma.contractTransaction.update({
         where: { txHash },
         data: {
            status: 'FAILED',
            lastError: failureMessage,
            errorKind: outcome?.status === 'FAILED' ? 'user' : 'transient',
            ...(outcome?.ledger ? { ledger: outcome.ledger } : {}),
            ...(outcome?.resultXdr ? { resultXdr: outcome.resultXdr } : {}),
         },
      });
   } catch (error) {
      logger.error(
         { tx_hash: txHash, error: (error as Error).message },
         'Failed to persist FAILED status'
      );
   }

   emitContractTxFailed({
      operation: input.operation,
      submitterWallet: input.submitterWallet,
      txHash,
      errorKind: outcome?.status === 'FAILED' ? 'user' : 'transient',
      lastError: failureMessage,
      attempts,
   });

   return {
      status: 'FAILED',
      txHash,
      errorKind: outcome?.status === 'FAILED' ? 'user' : 'transient',
      lastError: failureMessage,
      attempts,
   };
}
