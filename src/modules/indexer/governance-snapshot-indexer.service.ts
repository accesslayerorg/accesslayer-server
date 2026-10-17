// src/modules/indexer/governance-snapshot-indexer.service.ts
//
// Indexes `SnapshotTaken` contract events for governance proposals (#1036).
//
// Stores per-wallet snapshot voting weights in `governance_voting_snapshots`
// and updates the proposal's `snapshotTotalWeight` and `snapshotLedger`.
// Live balance changes after the snapshot do not affect stored snapshot weights.

import { logger } from '../../utils/logger.utils';
import { buildLogFields } from '../../utils/log-fields.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import {
   GovernanceProposalNotFoundError,
   recordProposalSnapshot,
   SnapshotTakenBalanceEntry,
} from '../governance/governance-proposals.service';

export interface SnapshotTakenChainEvent extends IndexerChainEvent {
   eventType: 'SNAPSHOT_TAKEN' | 'SnapshotTaken';
   keyId?: string;
   proposalId: string;
   snapshotLedger?: number;
   balances: SnapshotTakenBalanceEntry[] | Record<string, string | number>;
}

function isValidSnapshotTakenEvent(
   event: IndexerChainEvent
): event is SnapshotTakenChainEvent {
   const e = event as Partial<SnapshotTakenChainEvent>;
   const validType =
      event.eventType === 'SNAPSHOT_TAKEN' ||
      event.eventType === 'SnapshotTaken';
   const validProposalId =
      typeof e.proposalId === 'string' && e.proposalId.trim().length > 0;
   const validBalances =
      Array.isArray(e.balances) ||
      (typeof e.balances === 'object' && e.balances !== null);

   return validType && validProposalId && validBalances;
}

/**
 * Processes `SnapshotTaken` / `SNAPSHOT_TAKEN` contract events and persists
 * per-proposal wallet voting weight snapshots (#1036).
 */
export async function processGovernanceSnapshotEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (
         event.eventType !== 'SNAPSHOT_TAKEN' &&
         event.eventType !== 'SnapshotTaken'
      ) {
         return;
      }

      if (!isValidSnapshotTakenEvent(event)) {
         logger.warn(
            buildLogFields({
               type: 'governance_snapshot_event_invalid',
               eventId: `${event.txHash}:${event.eventIndex}`,
            }),
            'Skipping SnapshotTaken event with missing or invalid fields'
         );
         return;
      }

      const snapshotLedger =
         typeof event.snapshotLedger === 'number'
            ? event.snapshotLedger
            : typeof event.ledger === 'number'
              ? event.ledger
              : undefined;

      try {
         const result = await recordProposalSnapshot({
            keyId: event.keyId,
            proposalId: event.proposalId,
            snapshotLedger,
            balances: event.balances,
         });

         logger.info(
            buildLogFields({
               type: 'governance_snapshot_indexed',
               keyId: result.keyId,
               proposalId: result.proposalId,
               walletsIndexed: result.walletsIndexed,
               snapshotTotalWeight: result.snapshotTotalWeight,
               snapshotLedger,
               eventId: `${event.txHash}:${event.eventIndex}`,
            }),
            'Indexed governance proposal SnapshotTaken event'
         );
      } catch (error) {
         if (error instanceof GovernanceProposalNotFoundError) {
            logger.warn(
               buildLogFields({
                  type: 'governance_snapshot_proposal_not_found',
                  proposalId: event.proposalId,
                  keyId: event.keyId,
                  eventId: `${event.txHash}:${event.eventIndex}`,
               }),
               'SnapshotTaken event references unknown proposal'
            );
            return;
         }
         throw error;
      }
   });
}
