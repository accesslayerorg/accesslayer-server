// src/modules/indexer/circuit-breaker-indexer.service.ts
// Indexes CircuitBreakerTripped contract events (#987).
//
// Responsibilities:
//   - Record one CircuitBreakerTrip per event (key, creator wallet, the actual
//     price movement in basis points, the configured max bps, ledger, tx hash,
//     event index and on-chain timestamp), idempotently across replays.
//   - Persist the trip before logging a `circuit_breaker_tripped` notification
//     event, so each unique trip produces exactly one in-app notification for
//     the key's creator (see notification.service).

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';

/** Domain event type emitted by the contract's circuit breaker. */
export const CIRCUIT_BREAKER_TRIPPED_EVENT_TYPE = 'CIRCUIT_BREAKER_TRIPPED';

export interface CircuitBreakerTrippedEvent extends IndexerChainEvent {
   eventType: 'CIRCUIT_BREAKER_TRIPPED';
   /** Key (creator profile id or handle) whose breaker tripped. */
   keyId: string;
   /** Wallet that owns the creator's key, when the contract carries it. */
   creatorWallet?: string | null;
   /** Observed price movement, in basis points. */
   actualBps: number | string;
   /** Configured threshold at the time of the trip, in basis points. */
   maxBps?: number | string | null;
   ledger: number;
   txHash: string;
   eventIndex: number;
   /** On-chain timestamp (ISO string or Date). Defaults to now when absent. */
   occurredAt?: string | Date;
}

export interface IndexedCircuitBreakerTrip {
   keyId: string;
   creatorWallet: string;
   actualBps: number;
   maxBps: number | null;
   ledger: number;
   txHash: string;
   eventIndex: number;
   occurredAt: Date;
}

/**
 * Indexes a batch of CircuitBreakerTripped events.
 *
 * Each unique event inserts one trip row. Duplicate events (same txHash +
 * eventIndex) are skipped, so indexer replays cannot record a trip — or its
 * creator notification — more than once.
 */
export async function processCircuitBreakerEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (event.eventType !== CIRCUIT_BREAKER_TRIPPED_EVENT_TYPE) {
         return;
      }

      const typedEvent = event as CircuitBreakerTrippedEvent;
      const requiredFields = [
         'keyId',
         'actualBps',
         'ledger',
         'txHash',
         'eventIndex',
      ];
      for (const field of requiredFields) {
         const value = typedEvent[field as keyof CircuitBreakerTrippedEvent];
         if (value === undefined || value === null || value === '') {
            logger.warn(
               {
                  eventId: `${event.txHash}:${event.eventIndex}`,
                  missingField: field,
               },
               'Skipping circuit breaker event due to missing required field'
            );
            return;
         }
      }

      const actualBps = Number(typedEvent.actualBps);
      if (!Number.isFinite(actualBps)) {
         logger.warn(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               actualBps: typedEvent.actualBps,
            },
            'Skipping circuit breaker event with non-numeric actualBps'
         );
         return;
      }

      const profile = await prisma.creatorProfile.findFirst({
         where: {
            OR: [
               { id: String(typedEvent.keyId) },
               { handle: String(typedEvent.keyId) },
            ],
         },
         select: {
            id: true,
            user: {
               select: { stellarWallet: { select: { address: true } } },
            },
         },
      });

      if (!profile) {
         logger.warn(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               keyId: typedEvent.keyId,
            },
            'Circuit breaker event references unknown key; skipping'
         );
         return;
      }

      const creatorWallet =
         normalizeWallet(typedEvent.creatorWallet) ??
         profile.user?.stellarWallet?.address ??
         '';

      const inserted = await recordCircuitBreakerTrip({
         keyId: profile.id,
         creatorWallet,
         actualBps,
         maxBps: toOptionalBps(typedEvent.maxBps),
         ledger: Number(typedEvent.ledger),
         txHash: String(typedEvent.txHash),
         eventIndex: Number(typedEvent.eventIndex),
         occurredAt: toEventTimestamp(typedEvent.occurredAt),
      });

      if (!inserted) {
         return;
      }

      logger.info(
         {
            type: 'circuit_breaker_tripped',
            keyId: profile.id,
            creatorWallet,
            actualBps,
            maxBps: toOptionalBps(typedEvent.maxBps),
            ledger: typedEvent.ledger,
            txHash: typedEvent.txHash,
         },
         'Circuit breaker trip indexed; creator notification recorded'
      );
   });
}

/**
 * Inserts a single trip row. Returns false when the event was already recorded
 * (replay) or raced with a concurrent insert of the same event.
 */
async function recordCircuitBreakerTrip(
   trip: IndexedCircuitBreakerTrip
): Promise<boolean> {
   try {
      await prisma.circuitBreakerTrip.create({ data: trip });
      return true;
   } catch (error) {
      if (isUniqueConstraintError(error)) {
         logger.debug(
            {
               eventId: `${trip.txHash}:${trip.eventIndex}`,
               keyId: trip.keyId,
            },
            'Circuit breaker event already indexed; skipping duplicate'
         );
         return false;
      }
      throw error;
   }
}

/** True for Prisma's unique-constraint violation (P2002). */
function isUniqueConstraintError(error: unknown): boolean {
   if (!error || typeof error !== 'object') {
      return false;
   }
   return (error as { code?: unknown }).code === 'P2002';
}

function normalizeWallet(value: string | null | undefined): string | null {
   if (typeof value !== 'string') {
      return null;
   }
   const trimmed = value.trim();
   return trimmed.length > 0 ? trimmed : null;
}

function toOptionalBps(
   value: number | string | null | undefined
): number | null {
   if (value === undefined || value === null || value === '') {
      return null;
   }
   const parsed = Number(value);
   return Number.isFinite(parsed) ? parsed : null;
}

function toEventTimestamp(value: string | Date | undefined): Date {
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
