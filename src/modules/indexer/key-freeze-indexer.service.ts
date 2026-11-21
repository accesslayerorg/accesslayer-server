import { logger } from '../../utils/logger.utils';
import {
   IndexerChainEvent,
   processIndexerChainEvents,
} from '../../utils/indexer-event-processor.utils';
import { indexFreezeEvent } from '../freeze/freeze.service';

const FREEZE_EVENT_TYPES = new Set(['KEY_FROZEN', 'KEYFROZEN']);
const UNFREEZE_EVENT_TYPES = new Set(['KEY_UNFROZEN', 'KEYUNFROZEN']);

export interface KeyFreezeChainEvent extends IndexerChainEvent {
   ledger: number;
   txHash: string;
   eventIndex: number;
   keyId?: string | null;
   creatorId?: string | null;
   reason?: string | null;
   expiryTimestamp?: string | number | Date | null;
   expiresAt?: string | number | Date | null;
   occurredAt?: string | number | Date | null;
}

/** Indexes KeyFrozen/KeyUnfrozen events into the freeze read model and history. */
export async function processKeyFreezeEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      const eventType = event.eventType.replace(/[^a-z]/gi, '').toUpperCase();
      const type = FREEZE_EVENT_TYPES.has(eventType)
         ? 'FREEZE'
         : UNFREEZE_EVENT_TYPES.has(eventType)
           ? 'UNFREEZE'
           : null;
      if (!type) return;

      const typed = event as KeyFreezeChainEvent;
      if (
         !Number.isFinite(typed.ledger) ||
         !typed.txHash ||
         !Number.isFinite(typed.eventIndex)
      ) {
         logger.warn(
            { txHash: event.txHash, eventIndex: event.eventIndex },
            'Skipping key freeze event with missing chain metadata'
         );
         return;
      }
      const keyId = typed.keyId ?? typed.creatorId;
      if (typeof keyId !== 'string' || keyId.trim() === '') {
         logger.warn(
            { txHash: event.txHash, eventIndex: event.eventIndex },
            'Skipping key freeze event without a key identifier'
         );
         return;
      }

      const payload: Record<string, unknown> = {};
      for (const field of [
         'reason',
         'expiryTimestamp',
         'expiresAt',
         'occurredAt',
      ] as const) {
         const value = typed[field];
         if (value !== undefined && value !== null) {
            payload[field] =
               value instanceof Date ? value.toISOString() : value;
         }
      }
      await indexFreezeEvent({
         keyId: keyId.trim(),
         eventType: type,
         ledger: typed.ledger,
         txHash: event.txHash,
         eventIndex: typed.eventIndex,
         payload,
      });
   });
}
