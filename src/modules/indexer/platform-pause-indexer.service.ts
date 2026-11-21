// src/modules/indexer/platform-pause-indexer.service.ts
// Indexes PlatformPaused / PlatformResumed and per-key pause/resume contract
// events (#988).
//
// Responsibilities:
//   - On PlatformPaused, cache the platform pause state (timestamp + actor) so
//     every trade path rejects within seconds.
//   - On PlatformResumed, clear the platform pause cache.
//   - On per-key pause/resume, cache (or clear) the key's state independently,
//     so paused keys are blocked while other keys keep trading.

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   IndexerChainEvent,
   processIndexerChainEvents,
} from '../../utils/indexer-event-processor.utils';
import {
   clearKeyPaused,
   clearPlatformPaused,
   setKeyPaused,
   setPlatformPaused,
} from '../platform/platform-pause.service';

/** Domain event that pauses trading platform-wide. */
export const PLATFORM_PAUSED_EVENT_TYPE = 'PLATFORM_PAUSED';
/** Domain event that resumes trading platform-wide. */
export const PLATFORM_RESUMED_EVENT_TYPE = 'PLATFORM_RESUMED';

/** Domain event types that pause a single key's trading. */
export const KEY_PAUSED_EVENT_TYPES = new Set([
   'KEY_PAUSED',
   'KEY_TRADING_PAUSED',
   'TRADING_PAUSED',
]);

/** Domain event types that resume a single key's trading. */
export const KEY_RESUMED_EVENT_TYPES = new Set([
   'KEY_RESUMED',
   'KEY_TRADING_RESUMED',
   'TRADING_RESUMED',
]);

export interface PlatformPauseEvent extends IndexerChainEvent {
   /** Wallet or contract that triggered the pause/resume. */
   actor?: string | null;
   /** On-chain timestamp, when the contract emits one. */
   pausedAt?: string | Date | null;
   /** Alias for `pausedAt` seen on some contract events. */
   occurredAt?: string | Date | null;
   /** Key/creator the event applies to (per-key pause/resume only). */
   keyId?: string | null;
   creatorId?: string | null;
}

/**
 * Indexes a batch of platform and per-key pause/resume events, updating the
 * cached pause state as each event is processed.
 */
export async function processPlatformPauseEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      const typed = event as PlatformPauseEvent;

      if (typed.eventType === PLATFORM_PAUSED_EVENT_TYPE) {
         const state = await setPlatformPaused(
            normalizeActor(typed),
            toEventTimestamp(typed)
         );
         logger.info(
            {
               type: 'platform_paused',
               actor: state.actor,
               pausedAt: state.pausedAt,
               ledger: event.ledger,
               txHash: event.txHash,
            },
            'Platform pause state cached'
         );
         return;
      }

      if (typed.eventType === PLATFORM_RESUMED_EVENT_TYPE) {
         await clearPlatformPaused();
         logger.info(
            {
               type: 'platform_resumed',
               ledger: event.ledger,
               txHash: event.txHash,
            },
            'Platform pause state cleared'
         );
         return;
      }

      if (KEY_PAUSED_EVENT_TYPES.has(typed.eventType)) {
         const keyId = await resolveKeyId(typed);
         if (!keyId) {
            logger.warn(
               { eventId: `${event.txHash}:${event.eventIndex}` },
               'Skipping key pause event without a key identifier'
            );
            return;
         }
         await setKeyPaused(
            keyId,
            normalizeActor(typed),
            toEventTimestamp(typed)
         );
         logger.info(
            { type: 'key_trading_paused', keyId, ledger: event.ledger },
            'Key pause state cached'
         );
         return;
      }

      if (KEY_RESUMED_EVENT_TYPES.has(typed.eventType)) {
         const keyId = await resolveKeyId(typed);
         if (!keyId) {
            logger.warn(
               { eventId: `${event.txHash}:${event.eventIndex}` },
               'Skipping key resume event without a key identifier'
            );
            return;
         }
         await clearKeyPaused(keyId);
         logger.info(
            { type: 'key_trading_resumed', keyId, ledger: event.ledger },
            'Key pause state cleared'
         );
      }
   });
}

/** Resolves the event's key identifier to the canonical creator profile id. */
async function resolveKeyId(event: PlatformPauseEvent): Promise<string | null> {
   const raw = event.keyId ?? event.creatorId;
   if (raw === undefined || raw === null || String(raw).trim() === '') {
      return null;
   }
   const identifier = String(raw).trim();

   const profile = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: identifier }, { handle: identifier }] },
      select: { id: true },
   });
   return profile?.id ?? identifier;
}

function normalizeActor(event: PlatformPauseEvent): string | null {
   const actor = event.actor ?? event.triggeredBy;
   if (typeof actor !== 'string') {
      return null;
   }
   const trimmed = actor.trim();
   return trimmed.length > 0 ? trimmed : null;
}

function toEventTimestamp(event: PlatformPauseEvent): Date {
   const value = event.pausedAt ?? event.occurredAt;
   if (value instanceof Date) {
      return value;
   }
   if (typeof value === 'string') {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
         return parsed;
      }
   }
   return new Date();
}
