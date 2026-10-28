// src/modules/contracts/ledger-depth-gate.utils.ts
// Ledger-depth gate for buy/sell confirmations (#724).
//
// A Stellar ledger is not final the moment it closes — a short reorg can
// still replace it. To reduce reorg exposure, every buy/sell confirmation
// surfaced by the contract interaction service must wait until the ledger
// that included the transaction is at least CONFIRMED_LEDGER_DEPTH ledgers
// deep before the response (and the `contract_tx_confirmed` event) is
// released.
//
// The gate keeps polling `getTransaction` (which reports the network head
// as `latestLedger`) until `latestLedger - txLedger >= CONFIRMED_LEDGER_DEPTH`
// or the polling budget is exhausted. The clock/delay/status client are
// injectable so tests run with fake timers.

import { logger } from '../../utils/logger.utils';
import type { TransactionStatusClient } from './confirmation-poller.utils';

/** Required confirmed ledger depth before a buy/sell response is released. */
export const CONFIRMED_LEDGER_DEPTH = 2;

export interface DepthGateDeps {
   statusClient: TransactionStatusClient;
   /** Hash of the confirmed transaction; used to read the network head. */
   txHash: string;
   /** Delay between head polls, ms. */
   intervalMs: number;
   /** Total polling budget, ms. */
   timeoutMs: number;
   /** Delay implementation; defaults to a real setTimeout. */
   delay?: (ms: number) => Promise<void>;
   /** Monotonic-ish clock; injectable for tests. */
   now?: () => number;
}

export interface DepthGateResult {
   /** True when the including ledger reached the required depth in budget. */
   depthConfirmed: boolean;
   /** Last observed network head; 0 when none could be observed. */
   latestLedger: number;
}

const defaultDelay = (ms: number): Promise<void> =>
   new Promise(resolve => setTimeout(resolve, ms));

/**
 * Wait until `txLedger` is CONFIRMED_LEDGER_DEPTH ledgers deep.
 *
 * Never throws for poll-level errors — transient RPC failures are logged and
 * retried until the deadline, mirroring {@link pollForConfirmation}. When
 * the budget is exhausted without reaching the required depth the gate
 * reports `depthConfirmed: false`; callers decide whether to release or
 * withhold the response (the contract service releases with a warning so a
 * stalled RPC head cannot block confirmations forever).
 */
export async function waitForLedgerDepth(
   txLedger: number,
   deps: DepthGateDeps
): Promise<DepthGateResult> {
   const {
      statusClient,
      txHash,
      intervalMs,
      timeoutMs,
      delay = defaultDelay,
      now = Date.now,
   } = deps;

   const deadline = now() + timeoutMs;
   let latestLedger = 0;
   let lastError: string | null = null;

   while (now() < deadline) {
      try {
         const result = await statusClient.getTransaction(txHash);
         if (typeof result?.latestLedger === 'number') {
            latestLedger = result.latestLedger;
         }
         if (latestLedger - txLedger >= CONFIRMED_LEDGER_DEPTH) {
            return { depthConfirmed: true, latestLedger };
         }
      } catch (error) {
         lastError = error instanceof Error ? error.message : String(error);
         logger.warn(
            { tx_hash: txHash, error: lastError },
            'Ledger depth gate poll failed, will retry'
         );
      }

      await delay(intervalMs);
   }

   logger.warn(
      {
         tx_hash: txHash,
         tx_ledger: txLedger,
         latest_ledger: latestLedger,
         required_depth: CONFIRMED_LEDGER_DEPTH,
         timeout_ms: timeoutMs,
         error: lastError,
      },
      'Ledger depth gate timed out before the required confirmation depth'
   );

   return { depthConfirmed: false, latestLedger };
}
