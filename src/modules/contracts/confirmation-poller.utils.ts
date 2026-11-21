// src/modules/contracts/confirmation-poller.utils.ts
// Transaction confirmation polling for the Soroban contract interaction
// service (#899).
//
// After a transaction hash is accepted by the node, its inclusion in a ledger
// is confirmed by polling `getTransaction` on a fixed interval until the
// deadline. The poller is dependency-injected (client + clock + delay) so
// unit tests run synchronously with fake timers.

import { logger } from '../../utils/logger.utils';
import type { GetTransactionResult } from '../../clients/soroban.client';

/** Minimal shape of the Soroban client the poller depends on. */
export interface TransactionStatusClient {
   getTransaction(
      hash: string
   ): Promise<
      Pick<GetTransactionResult, 'status' | 'ledger' | 'resultXdr'> & {
         latestLedger?: number;
      }
   >;
}

export interface PollerDeps {
   statusClient: TransactionStatusClient;
   /** Delay between polls, ms. */
   intervalMs: number;
   /** Total polling budget, ms. */
   timeoutMs: number;
   /** Delay implementation; defaults to a real setTimeout. */
   delay?: (ms: number) => Promise<void>;
   /** Monotonic-ish clock; injectable for tests. */
   now?: () => number;
}

const defaultDelay = (ms: number): Promise<void> =>
   new Promise(resolve => setTimeout(resolve, ms));

export type PollOutcome =
   | { status: 'SUCCESS'; ledger: number; resultXdr?: string }
   | { status: 'FAILED'; ledger?: number; resultXdr?: string; lastError: string };

/**
 * Poll for transaction confirmation until the ledger includes it, the
 * transaction fails on-chain, or the polling budget is exhausted.
 *
 * Never throws for poll-level errors — transient RPC failures are logged and
 * retried until the deadline, so a single bad poll does not abort tracking.
 *
 * @returns SUCCESS with ledger info, FAILED with the on-chain error, or
 *          null when the polling window elapsed without resolution.
 */
export async function pollForConfirmation(
   txHash: string,
   deps: PollerDeps
): Promise<PollOutcome | null> {
   const {
      statusClient,
      intervalMs,
      timeoutMs,
      delay = defaultDelay,
      now = Date.now,
   } = deps;

   const deadline = now() + timeoutMs;
   let lastError: string | null = null;

   while (now() < deadline) {
      let result: GetTransactionResult | null = null;
      try {
         result = await statusClient.getTransaction(txHash);
      } catch (error) {
         lastError = error instanceof Error ? error.message : String(error);
         logger.warn(
            { tx_hash: txHash, error: lastError },
            'Transaction status poll failed, will retry'
         );
      }

      if (result) {
         if (result.status === 'SUCCESS') {
            return {
               status: 'SUCCESS',
               ledger: result.ledger ?? result.latestLedger ?? 0,
               resultXdr: result.resultXdr,
            };
         }
         if (result.status === 'FAILED') {
            return {
               status: 'FAILED',
               ledger: result.ledger,
               resultXdr: result.resultXdr,
               lastError: lastError ?? 'Transaction failed on-chain',
            };
         }
      }

      await delay(intervalMs);
   }

   logger.warn(
      { tx_hash: txHash, timeout_ms: timeoutMs },
      'Transaction confirmation polling timed out'
   );
   return null;
}
