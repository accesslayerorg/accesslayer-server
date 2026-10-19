// src/modules/indexer/key-reserve-indexer.service.ts
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
   getChainEventId,
} from '../../utils/indexer-event-processor.utils';
import { invalidateKeyReserveCache } from '../keys/key-reserve.service';
import { Decimal } from '@prisma/client/runtime/library';

export interface ReserveAccruedChainEvent extends IndexerChainEvent {
   eventType: 'ReserveAccrued';
   keyId: string;
   amount: string | number;
}

export interface ReserveDeployedChainEvent extends IndexerChainEvent {
   eventType: 'ReserveDeployed';
   keyId: string;
   amount: string | number;
}

export type KeyReserveChainEvent =
   | ReserveAccruedChainEvent
   | ReserveDeployedChainEvent;

export async function processKeyReserveEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (
         event.eventType !== 'ReserveAccrued' &&
         event.eventType !== 'ReserveDeployed'
      ) {
         return;
      }

      const reserveEvent = event as KeyReserveChainEvent;
      const { keyId, amount } = reserveEvent;

      if (!keyId) {
         logger.warn(
            { eventId: getChainEventId(event) },
            'Skipping key reserve event with missing keyId'
         );
         return;
      }

      const delta = new Decimal(amount || 0);

      const existing = await prisma.keyReserve.findUnique({
         where: { keyId },
      });

      let updatedBalance: Decimal;

      if (event.eventType === 'ReserveAccrued') {
         if (existing) {
            updatedBalance = existing.reserveBalance.plus(delta);
         } else {
            updatedBalance = delta;
         }
      } else {
         // ReserveDeployed
         if (existing) {
            const subtracted = existing.reserveBalance.minus(delta);
            updatedBalance = subtracted.isNegative() ? new Decimal(0) : subtracted;
         } else {
            updatedBalance = new Decimal(0);
         }
      }

      await prisma.keyReserve.upsert({
         where: { keyId },
         create: {
            keyId,
            reserveBalance: updatedBalance,
         },
         update: {
            reserveBalance: updatedBalance,
         },
      });

      // Invalidate Redis cache
      await invalidateKeyReserveCache(keyId);
   });
}
