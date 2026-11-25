// src/modules/indexer/protocol-escape-indexer.service.ts
// Indexes protocol pause/unpause and escape-hatch redemption events (#1265).
//
// Every row is keyed by (txHash, eventIndex). A replayed event hits the unique
// constraint and is skipped, so pause state and redemptions never duplicate.

import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   IndexerChainEvent,
   processIndexerChainEvents,
} from '../../utils/indexer-event-processor.utils';

export const PROTOCOL_PAUSED_EVENT_TYPES = new Set([
   'paused',
   'Paused',
   'PAUSED',
]);
export const PROTOCOL_UNPAUSED_EVENT_TYPES = new Set([
   'unpaused',
   'Unpaused',
   'UNPAUSED',
]);
export const ESCAPE_REDEEMED_EVENT_TYPES = new Set([
   'escape_redeemed',
   'EscapeRedeemed',
   'ESCAPE_REDEEMED',
]);

export const PROTOCOL_ESCAPE_EVENT_TYPES = new Set([
   ...PROTOCOL_PAUSED_EVENT_TYPES,
   ...PROTOCOL_UNPAUSED_EVENT_TYPES,
   ...ESCAPE_REDEEMED_EVENT_TYPES,
]);

export function isProtocolEscapeEvent(event: IndexerChainEvent): boolean {
   return PROTOCOL_ESCAPE_EVENT_TYPES.has(event.eventType);
}

function eventId(event: IndexerChainEvent): string {
   return `${event.txHash}:${event.eventIndex}`;
}

function stringValue(value: unknown): string | null {
   if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
   }
   if (typeof value === 'number' || typeof value === 'bigint') {
      return String(value);
   }
   return null;
}

function requiredString(
   event: IndexerChainEvent,
   name: string,
   ...candidates: unknown[]
): string {
   const value = candidates.map(stringValue).find(c => c !== null);
   if (value) return value;
   logger.error(
      { eventId: eventId(event), missingField: name },
      'Cannot index protocol escape event with missing required data'
   );
   throw new Error(`Protocol escape event is missing required ${name}`);
}

function requiredLedger(event: IndexerChainEvent): number {
   const ledger = Number(event.ledger);
   if (!Number.isInteger(ledger)) {
      throw new Error(`Protocol escape event ${eventId(event)} has no ledger`);
   }
   return ledger;
}

function eventDate(...values: unknown[]): Date | null {
   for (const value of values) {
      if (value instanceof Date && !Number.isNaN(value.getTime())) {
         return value;
      }
      if (typeof value === 'string' && value.trim() !== '') {
         const date = new Date(value);
         if (!Number.isNaN(date.getTime())) return date;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
         // Values below 1e12 are Unix seconds, the rest are milliseconds.
         const date = new Date(value < 1_000_000_000_000 ? value * 1000 : value);
         if (!Number.isNaN(date.getTime())) return date;
      }
   }
   return null;
}

function isUniqueConstraintError(error: unknown): boolean {
   return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
   );
}

async function applyPauseState(
   event: IndexerChainEvent,
   kind: 'paused' | 'unpaused'
): Promise<void> {
   try {
      await prisma.protocolPauseEvent.create({
         data: {
            kind,
            ledger: requiredLedger(event),
            eventIndex: event.eventIndex,
            txHash: event.txHash,
            occurredAt:
               eventDate(event.occurredAt, event.pausedAt, event.timestamp) ??
               new Date(),
         },
      });
   } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      logger.info(
         { eventId: eventId(event), kind },
         'Protocol pause event already indexed; skipping duplicate event'
      );
   }
}

async function applyEscapeRedemption(event: IndexerChainEvent): Promise<void> {
   const keyId = requiredString(event, 'keyId', event.keyId, event.key_id, event.creatorId);
   const wallet = requiredString(event, 'wallet', event.wallet, event.redeemer, event.owner);
   const rawAmount = stringValue(event.amount);
   if (rawAmount === null || !/^\d+(?:\.\d{1,7})?$/.test(rawAmount)) {
      logger.error(
         { eventId: eventId(event), rawAmount },
         'Cannot index escape redemption with invalid amount'
      );
      throw new Error('Escape redemption event has an invalid amount');
   }

   try {
      await prisma.escapeRedemption.create({
         data: {
            keyId,
            wallet,
            amount: new Decimal(rawAmount),
            ledger: requiredLedger(event),
            eventIndex: event.eventIndex,
            txHash: event.txHash,
            redeemedAt:
               eventDate(event.occurredAt, event.redeemedAt, event.timestamp) ??
               new Date(),
         },
      });
   } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      logger.info(
         { eventId: eventId(event), keyId, wallet },
         'Escape redemption already indexed; skipping duplicate event'
      );
   }
}

export async function processProtocolEscapeEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (PROTOCOL_PAUSED_EVENT_TYPES.has(event.eventType)) {
         await applyPauseState(event, 'paused');
      } else if (PROTOCOL_UNPAUSED_EVENT_TYPES.has(event.eventType)) {
         await applyPauseState(event, 'unpaused');
      } else if (ESCAPE_REDEEMED_EVENT_TYPES.has(event.eventType)) {
         await applyEscapeRedemption(event);
      }
   });
}
