import { prisma } from '../../utils/prisma.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { logger } from '../../utils/logger.utils';
import { invalidateReputationCache } from '../../middleware/reputation/reputation.service';

export const SELL_BLOCK_EVENT_TYPES = new Set([
   'same_ledger_sell_blocked',
   'SAME_LEDGER_SELL_BLOCKED',
]);

export interface SameLedgerSellBlockedEvent extends IndexerChainEvent {
   eventType: 'same_ledger_sell_blocked' | 'SAME_LEDGER_SELL_BLOCKED';
   wallet: string;
   keyId: string;
   amount: string | number | bigint;
   ledger: number;
   txHash: string;
   eventIndex: number;
}

function isValidAmount(value: unknown): value is string | number | bigint {
   return (
      typeof value === 'bigint' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.trim().length > 0)
   );
}

/**
 * Persist blocked same-ledger sells once per chain event so replays don't
 * inflate analytics or the wallet's reputation penalty.
 */
export async function processSellBlockEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!SELL_BLOCK_EVENT_TYPES.has(event.eventType)) {
         return;
      }

      const typedEvent = event as SameLedgerSellBlockedEvent;
      const requiredFields = [
         'wallet',
         'keyId',
         'amount',
         'ledger',
         'txHash',
         'eventIndex',
      ];
      for (const field of requiredFields) {
         const value = typedEvent[field as keyof SameLedgerSellBlockedEvent];
         if (value === undefined || value === null || value === '') {
            logger.warn(
               {
                  eventId: `${event.txHash}:${event.eventIndex}`,
                  missingField: field,
               },
               'Skipping same-ledger sell block event due to missing required field'
            );
            return;
         }
      }

      if (
         typeof typedEvent.wallet !== 'string' ||
         typeof typedEvent.keyId !== 'string' ||
         !Number.isSafeInteger(typedEvent.ledger) ||
         typedEvent.ledger < 0 ||
         !Number.isSafeInteger(typedEvent.eventIndex) ||
         typedEvent.eventIndex < 0 ||
         !isValidAmount(typedEvent.amount)
      ) {
         logger.warn(
            { eventId: `${event.txHash}:${event.eventIndex}` },
            'Skipping same-ledger sell block event due to invalid fields'
         );
         return;
      }

      try {
         await prisma.sellBlock.create({
            data: {
               wallet: typedEvent.wallet,
               keyId: typedEvent.keyId,
               amount: String(typedEvent.amount),
               ledger: typedEvent.ledger,
               txHash: typedEvent.txHash,
               eventIndex: typedEvent.eventIndex,
            },
         });
      } catch (error) {
         if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'P2002'
         ) {
            return;
         }
         throw error;
      }

      await invalidateReputationCache(typedEvent.wallet);
   });
}
