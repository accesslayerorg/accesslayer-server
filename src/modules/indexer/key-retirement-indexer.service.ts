import { prisma } from '../../utils/prisma.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import {
   IndexerChainEvent,
   processIndexerChainEvents,
} from '../../utils/indexer-event-processor.utils';
import { keyRetirementCacheKey } from '../keys/key-retirement.service';

export const KEY_RETIREMENT_EVENT_TYPES = new Set([
   'RetirementProposed',
   'RETIREMENT_PROPOSED',
   'RetirementExecuted',
   'RETIREMENT_EXECUTED',
   'DeprecationExecuted',
   'DEPRECATION_EXECUTED',
]);

function eventDate(value: unknown): Date {
   if (
      typeof value === 'number' ||
      (typeof value === 'string' && /^\d+$/.test(value))
   ) {
      const n = Number(value);
      const result = new Date(n < 1e12 ? n * 1000 : n);
      if (!Number.isNaN(result.getTime())) return result;
   }
   const result = value ? new Date(String(value)) : new Date();
   return Number.isNaN(result.getTime()) ? new Date() : result;
}

export async function processKeyRetirementEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!KEY_RETIREMENT_EVENT_TYPES.has(event.eventType)) return;
      const keyId = String(event.keyId ?? event.creatorId ?? '').trim();
      if (!keyId)
         throw new Error(`Invalid ${event.eventType}: keyId is required`);
      const proposed =
         event.eventType === 'RetirementProposed' ||
         event.eventType === 'RETIREMENT_PROPOSED';
      const deprecated =
         event.eventType === 'DeprecationExecuted' ||
         event.eventType === 'DEPRECATION_EXECUTED';
      await prisma.keyRetirement.upsert({
         where: {
            txHash_eventIndex: {
               txHash: event.txHash,
               eventIndex: event.eventIndex,
            },
         },
         create: {
            keyId,
            eventType: event.eventType,
            status: proposed
               ? 'proposed'
               : deprecated
                 ? 'deprecated'
                 : 'retired',
            buybackPrice:
               event.buybackPrice == null
                  ? undefined
                  : String(event.buybackPrice),
            noticeExpiry:
               (event.noticeExpiry ?? event.noticeExpiresAt)
                  ? eventDate(event.noticeExpiry ?? event.noticeExpiresAt)
                  : undefined,
            reason: event.reason == null ? undefined : String(event.reason),
            occurredAt: eventDate(
               event.occurredAt ??
                  event.executedAt ??
                  event.proposedAt ??
                  event.timestamp
            ),
            txHash: event.txHash,
            eventIndex: event.eventIndex,
            ledger: Number(event.ledger ?? 0),
         },
         update: {},
      });
      await cacheInvalidate(keyRetirementCacheKey(keyId));
   });
}
