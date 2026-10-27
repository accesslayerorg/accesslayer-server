// src/modules/indexer/key-tipping-indexer.service.ts
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
   getChainEventId,
} from '../../utils/indexer-event-processor.utils';
import { invalidateKeyTipsCache } from '../keys/key-tipping.service';
import { Decimal } from '@prisma/client/runtime/library';

export interface TipSentChainEvent extends IndexerChainEvent {
   eventType: 'TipSent';
   keyId: string;
   tipper: string;
   amount: string | number;
   messageHash?: string;
   messageCid?: string;
   messageText?: string;
}

export type KeyTippingChainEvent = TipSentChainEvent;

export async function processKeyTippingEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (event.eventType !== 'TipSent') {
         return;
      }

      const tipEvent = event as TipSentChainEvent;
      const { keyId, tipper, amount, messageHash, messageCid, messageText, ledger, txHash } = tipEvent;

      if (!keyId || !tipper) {
         logger.warn(
            { eventId: getChainEventId(event) },
            'Skipping TipSent event with missing keyId or tipper'
         );
         return;
      }

      const amountDec = new Decimal(amount || 0);

      await prisma.keyTip.create({
         data: {
            keyId,
            tipper,
            amount: amountDec,
            messageHash: messageHash || null,
            messageCid: messageCid || null,
            messageText: messageText || null,
            ledger: ledger || null,
            txHash: txHash || null,
            createdAt: event.timestamp ? new Date(event.timestamp) : new Date(),
         },
      });

      await invalidateKeyTipsCache(keyId);
   });
}
