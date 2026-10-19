// src/modules/indexer/key-retirement-indexer.service.ts
//
// Indexes key retirement and deprecation events into the `key_retirement` table (#1116).
//
// Events supported:
// - RetirementProposed (or RETIREMENT_PROPOSED) -> status: 'proposed'
// - RetirementExecuted (or RETIREMENT_EXECUTED) -> status: 'retired'
// - DeprecationExecuted (or DEPRECATION_EXECUTED) -> status: 'deprecated'

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { cacheInvalidate } from '../../utils/redis.utils';

export const KEY_RETIREMENT_EVENT_TYPES: ReadonlySet<string> = new Set([
   'RetirementProposed',
   'RETIREMENT_PROPOSED',
   'RetirementExecuted',
   'RETIREMENT_EXECUTED',
   'DeprecationExecuted',
   'DEPRECATION_EXECUTED',
]);

export function isKeyRetirementEvent(
   event: IndexerChainEvent
): boolean {
   return KEY_RETIREMENT_EVENT_TYPES.has(event.eventType);
}

export type RetirementStatus = 'proposed' | 'retired' | 'deprecated';

export interface KeyRetirementEventPayload extends IndexerChainEvent {
   keyId?: string;
   creatorId?: string;
   key_id?: string;
   buybackPrice?: string | number | bigint;
   buybackPriceXlm?: string | number | bigint;
   buyback_price?: string | number | bigint;
   price?: string | number | bigint;
   noticeExpiry?: string | number | Date;
   notice_expiry?: string | number | Date;
   noticeExpiryTimestamp?: string | number | Date;
   expiresAt?: string | number | Date;
   reason?: string;
   actor?: string;
   proposedBy?: string;
   executedBy?: string;
   caller?: string;
}

export function parseNoticeExpiry(value: unknown): Date | null {
   if (value === undefined || value === null || value === '') return null;
   if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
   }
   if (typeof value === 'number') {
      // Numbers < 1e12 are epoch seconds (Soroban timestamps); above, ms
      const ms = value < 1e12 ? value * 1000 : value;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d;
   }
   if (typeof value === 'string') {
      const trimmed = value.trim();
      if (/^\d+$/.test(trimmed)) {
         const n = Number(trimmed);
         const ms = n < 1e12 ? n * 1000 : n;
         const d = new Date(ms);
         return Number.isNaN(d.getTime()) ? null : d;
      }
      const d = new Date(trimmed);
      return Number.isNaN(d.getTime()) ? null : d;
   }
   return null;
}

export function resolveRetirementStatus(eventType: string): RetirementStatus {
   const upper = eventType.toUpperCase();
   if (upper.includes('PROPOSED')) {
      return 'proposed';
   }
   if (upper.includes('DEPRECATION')) {
      return 'deprecated';
   }
   return 'retired';
}

/**
 * Processes a batch of on-chain key retirement and deprecation events.
 * Idempotent by (txHash, eventIndex).
 */
export async function processKeyRetirementEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async rawEvent => {
      if (!isKeyRetirementEvent(rawEvent)) {
         return;
      }

      const event = rawEvent as KeyRetirementEventPayload;
      const keyId = event.keyId || event.creatorId || event.key_id;
      if (!keyId || typeof keyId !== 'string') {
         logger.warn(
            { eventType: event.eventType, txHash: event.txHash },
            'Key retirement event skipped: missing keyId'
         );
         return;
      }

      const status = resolveRetirementStatus(event.eventType);

      const rawPrice =
         event.buybackPrice ??
         event.buyback_price ??
         event.buybackPriceXlm ??
         event.price;
      const buybackPrice =
         rawPrice !== undefined && rawPrice !== null ? String(rawPrice) : null;

      const rawExpiry =
         event.noticeExpiry ??
         event.notice_expiry ??
         event.noticeExpiryTimestamp ??
         event.expiresAt;
      const noticeExpiry = parseNoticeExpiry(rawExpiry);

      const reason = event.reason ?? null;
      const actor =
         event.actor ||
         event.proposedBy ||
         event.executedBy ||
         event.caller ||
         null;

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
            status,
            buybackPrice,
            noticeExpiry,
            reason,
            actor,
            ledger: event.ledger ?? 0,
            txHash: event.txHash,
            eventIndex: event.eventIndex ?? 0,
         },
         update: {
            status,
            buybackPrice,
            noticeExpiry,
            reason,
            actor,
         },
      });

      try {
         await cacheInvalidate(`key:retirement:${keyId}`);
      } catch {
         // Non-critical cache failure
      }

      logger.info(
         {
            eventType: event.eventType,
            keyId,
            status,
            buybackPrice,
            txHash: event.txHash,
         },
         `Indexed ${event.eventType} for key ${keyId}`
      );
   });
}
