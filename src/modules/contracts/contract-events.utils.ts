// src/modules/contracts/contract-events.utils.ts
// Resolution event emitter for the Soroban contract interaction service (#899).
//
// Downstream consumers (notifications, indexer reconciliation, analytics)
// subscribe to `contract_tx_confirmed` / `contract_tx_failed` instead of
// polling the database. Emission failures are logged but never propagate to
// the submission flow — events are advisory, not critical path.

import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.utils';
import type {
   ContractServiceEvent,
   ContractTxConfirmedEvent,
   ContractTxFailedEvent,
} from './contract.types';

const eventEmitter = new EventEmitter();
eventEmitter.setMaxListeners(50);

/** Domain event names emitted by the contract interaction service. */
export const CONTRACT_EVENTS = {
   TX_CONFIRMED: 'contract_tx_confirmed',
   TX_FAILED: 'contract_tx_failed',
} as const;

/**
 * Subscribe to a contract service event.
 *
 * @param event - Event name from {@link CONTRACT_EVENTS}.
 * @param handler - Callback invoked with the typed event payload.
 * @returns An unsubscribe function.
 */
export function onContractEvent<T extends ContractServiceEvent['type']>(
   event: T,
   handler: (payload: Extract<ContractServiceEvent, { type: T }>) => void
): () => void {
   eventEmitter.on(event, handler);
   return () => {
      eventEmitter.off(event, handler);
   };
}

/** Emit a confirmation event. Never throws. */
export function emitContractTxConfirmed(
   payload: ContractTxConfirmedEvent
): void {
   try {
      eventEmitter.emit(CONTRACT_EVENTS.TX_CONFIRMED, payload);
      logger.info(
         {
            event: CONTRACT_EVENTS.TX_CONFIRMED,
            operation: payload.operation,
            tx_hash: payload.txHash,
            ledger: payload.ledger,
            submitter_wallet: payload.submitterWallet,
         },
         'Contract transaction confirmed'
      );
   } catch (error) {
      logger.error(
         { error },
         'Failed to emit contract_tx_confirmed event'
      );
   }
}

/** Emit a failure event. Never throws. */
export function emitContractTxFailed(payload: ContractTxFailedEvent): void {
   try {
      eventEmitter.emit(CONTRACT_EVENTS.TX_FAILED, payload);
      logger.warn(
         {
            event: CONTRACT_EVENTS.TX_FAILED,
            operation: payload.operation,
            tx_hash: payload.txHash,
            error_kind: payload.errorKind,
            last_error: payload.lastError,
            submitter_wallet: payload.submitterWallet,
         },
         'Contract transaction failed'
      );
   } catch (error) {
      logger.error(
         { error },
         'Failed to emit contract_tx_failed event'
      );
   }
}

/** Test helper: remove all listeners. */
export function removeAllContractEventListeners(): void {
   eventEmitter.removeAllListeners();
}
