import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   IndexerChainEvent,
   processIndexerChainEvents,
} from '../../utils/indexer-event-processor.utils';

export const PASS_EVENT_CREATED_TYPES = new Set([
   'event_created',
   'EventCreated',
   'EVENT_CREATED',
]);

export const PASS_EVENT_REDEEMED_TYPES = new Set([
   'redeemed',
   'Redeemed',
   'REDEEMED',
   'pass_redeemed',
   'PassRedeemed',
]);

export const PASS_EVENT_CLOSED_TYPES = new Set([
   'event_closed',
   'EventClosed',
   'EVENT_CLOSED',
]);

export const PASS_EVENT_TYPES = new Set([
   ...PASS_EVENT_CREATED_TYPES,
   ...PASS_EVENT_REDEEMED_TYPES,
   ...PASS_EVENT_CLOSED_TYPES,
]);

function requiredString(event: IndexerChainEvent, ...fields: string[]): string {
   for (const field of fields) {
      const value = event[field];
      if (value != null && String(value).trim() !== '') {
         return String(value).trim();
      }
   }
   throw new Error(`Invalid ${event.eventType}: ${fields[0]} is required`);
}

function requiredInt(event: IndexerChainEvent, ...fields: string[]): number {
   const raw = requiredString(event, ...fields);
   const value = Number(raw);
   if (!Number.isInteger(value) || value < 0) {
      throw new Error(
         `Invalid ${event.eventType}: ${fields[0]} must be a non-negative integer`
      );
   }
   return value;
}

async function handleEventCreated(event: IndexerChainEvent): Promise<void> {
   const id = requiredString(event, 'eventId', 'id');
   const keyId = requiredString(event, 'keyId', 'creatorId');
   const creatorWallet = requiredString(event, 'creatorWallet', 'creator', 'actor');
   const startLedger = requiredInt(event, 'startLedger');
   const endLedger = requiredInt(event, 'endLedger');
   const capacity = requiredInt(event, 'capacity');
   const minBalance =
      event.minBalance != null ? String(event.minBalance) : '1';
   const title = event.title != null ? String(event.title) : null;

   await prisma.passEvent.upsert({
      where: { id },
      create: {
         id,
         keyId,
         creatorWallet,
         title,
         startLedger,
         endLedger,
         capacity,
         minBalance,
         closed: false,
         createdTxHash: event.txHash,
         createdEventIndex: event.eventIndex,
      },
      update: {},
   });
}

async function handleRedeemed(event: IndexerChainEvent): Promise<void> {
   const eventId = requiredString(event, 'eventId', 'id');
   const wallet = requiredString(event, 'wallet', 'holder', 'actor');

   await prisma.$transaction(async tx => {
      const passEvent = await tx.passEvent.findUnique({
         where: { id: eventId },
      });
      if (!passEvent) {
         logger.warn(
            { eventId, txHash: event.txHash },
            'redeemed event received for unknown PassEvent'
         );
         return;
      }

      const existingByTx = await tx.passRedemption.findUnique({
         where: {
            txHash_eventIndex: {
               txHash: event.txHash,
               eventIndex: event.eventIndex,
            },
         },
      });
      if (existingByTx) {
         return;
      }

      const existingByWallet = await tx.passRedemption.findUnique({
         where: {
            eventId_wallet: { eventId, wallet },
         },
      });
      if (existingByWallet) {
         return;
      }

      await tx.passRedemption.create({
         data: {
            eventId,
            wallet,
            txHash: event.txHash,
            eventIndex: event.eventIndex,
            ledger: event.ledger ?? 0,
         },
      });

      await tx.passEvent.update({
         where: { id: eventId },
         data: { redeemedCount: { increment: 1 } },
      });
   });
}

async function handleEventClosed(event: IndexerChainEvent): Promise<void> {
   const eventId = requiredString(event, 'eventId', 'id');

   await prisma.passEvent.updateMany({
      where: { id: eventId, closed: false },
      data: {
         closed: true,
         closedTxHash: event.txHash,
         closedEventIndex: event.eventIndex,
      },
   });
}

export async function processPassEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (PASS_EVENT_CREATED_TYPES.has(event.eventType)) {
         await handleEventCreated(event);
      } else if (PASS_EVENT_REDEEMED_TYPES.has(event.eventType)) {
         await handleRedeemed(event);
      } else if (PASS_EVENT_CLOSED_TYPES.has(event.eventType)) {
         await handleEventClosed(event);
      }
   });
}
