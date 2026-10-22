// src/modules/indexer/key-fee-indexer.service.ts
// Indexes FeeAdjusted contract events to track fee tier change history
// and invalidates the 60s swap fee cache for affected keys.

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { invalidateKeyFeeCache } from '../keys/key-swap-fee.service';

export const FEE_ADJUSTED_EVENT_TYPES = [
   'FeeAdjusted',
   'FEE_ADJUSTED',
   'fee_adjusted',
] as const;

export interface FeeAdjustedChainEvent extends IndexerChainEvent {
   eventType: 'FeeAdjusted' | 'FEE_ADJUSTED' | 'fee_adjusted';
   keyId: string;
   feeBps: number | string;
   previousFeeBps?: number | string | null;
   volumeBracket?: string | null;
   rolling24hVolume?: string | null;
   ledger: number;
   txHash: string;
   eventIndex: number;
   timestamp?: string | Date;
}

export async function processFeeAdjustedEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      const isFeeAdjusted = FEE_ADJUSTED_EVENT_TYPES.includes(
         event.eventType as any
      );

      if (!isFeeAdjusted) {
         return;
      }

      const typedEvent = event as FeeAdjustedChainEvent;

      const requiredFields = [
         'keyId',
         'feeBps',
         'ledger',
         'txHash',
         'eventIndex',
      ];
      for (const field of requiredFields) {
         const value = (typedEvent as any)[field];
         if (value === undefined || value === null || value === '') {
            logger.warn(
               {
                  eventId: `${event.txHash}:${event.eventIndex}`,
                  missingField: field,
               },
               'Skipping FeeAdjusted event due to missing required field'
            );
            return;
         }
      }

      const feeBps = Number(typedEvent.feeBps);
      if (!Number.isFinite(feeBps) || feeBps < 0) {
         logger.warn(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               feeBps: typedEvent.feeBps,
            },
            'Skipping FeeAdjusted event with invalid feeBps'
         );
         return;
      }

      const previousFeeBps =
         typedEvent.previousFeeBps !== undefined &&
         typedEvent.previousFeeBps !== null
            ? Number(typedEvent.previousFeeBps)
            : null;

      // Resolve key to creator profile
      const profile = await prisma.creatorProfile.findFirst({
         where: {
            OR: [{ id: typedEvent.keyId }, { handle: typedEvent.keyId }],
         },
         select: { id: true },
      });

      const resolvedKeyId = profile ? profile.id : typedEvent.keyId;

      const occurredAt = typedEvent.timestamp
         ? new Date(typedEvent.timestamp)
         : new Date();

      // Persist to key_fee_history idempotently
      await prisma.keyFeeHistory.upsert({
         where: {
            txHash_eventIndex: {
               txHash: typedEvent.txHash,
               eventIndex: typedEvent.eventIndex,
            },
         },
         create: {
            keyId: resolvedKeyId,
            feeBps,
            previousFeeBps,
            volumeBracket: typedEvent.volumeBracket ?? null,
            rolling24hVolume: typedEvent.rolling24hVolume ?? null,
            ledger: Number(typedEvent.ledger),
            txHash: typedEvent.txHash,
            eventIndex: Number(typedEvent.eventIndex),
            timestamp: occurredAt,
         },
         update: {
            feeBps,
            previousFeeBps,
            volumeBracket: typedEvent.volumeBracket ?? null,
            rolling24hVolume: typedEvent.rolling24hVolume ?? null,
            timestamp: occurredAt,
         },
      });

      // Invalidate 60s swap fee cache for the affected key
      await invalidateKeyFeeCache(resolvedKeyId);

      logger.info(
         {
            type: 'fee_adjusted_indexed',
            keyId: resolvedKeyId,
            feeBps,
            txHash: typedEvent.txHash,
            eventIndex: typedEvent.eventIndex,
            ledger: typedEvent.ledger,
         },
         'FeeAdjusted event indexed and cache invalidated'
      );
   });
}
