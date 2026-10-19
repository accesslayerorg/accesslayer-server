// src/modules/indexer/key-curve-update-indexer.service.ts
//
// Indexes key curve update timelock proposals and executions (#1113).
//
// Events supported:
// - CurveUpdateProposed (or CURVE_UPDATE_PROPOSED) -> status: 'pending'
// - CurveUpdateExecuted (or CURVE_UPDATE_EXECUTED) -> status: 'completed', outcome: 'executed'
// - CurveUpdateCancelled (or CURVE_UPDATE_CANCELLED) -> status: 'cancelled', outcome: 'cancelled'

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { cacheInvalidate } from '../../utils/redis.utils';

export const CURVE_UPDATE_EVENT_TYPES: ReadonlySet<string> = new Set([
   'CurveUpdateProposed',
   'CURVE_UPDATE_PROPOSED',
   'CurveUpdateExecuted',
   'CURVE_UPDATE_EXECUTED',
   'CurveUpdateCancelled',
   'CURVE_UPDATE_CANCELLED',
]);

export function isCurveUpdateEvent(event: IndexerChainEvent): boolean {
   return CURVE_UPDATE_EVENT_TYPES.has(event.eventType);
}

export interface CurveUpdateEventPayload extends IndexerChainEvent {
   keyId?: string;
   creatorId?: string;
   key_id?: string;
   proposalId?: string | number;
   proposal_id?: string | number;
   id?: string | number;
   proposedParams?: any;
   proposed_params?: any;
   params?: any;
   curveParams?: any;
   eta?: string | number | Date;
   etaTimestamp?: string | number | Date;
   executionEta?: string | number | Date;
   timelockExpiry?: string | number | Date;
   proposer?: string;
   proposedBy?: string;
   executor?: string;
   executedBy?: string;
   actor?: string;
   executedAt?: string | number | Date;
   timestamp?: string | number | Date;
}

export function parseDate(value: unknown): Date | null {
   if (value === undefined || value === null || value === '') return null;
   if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
   }
   if (typeof value === 'number') {
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

/**
 * Processes on-chain CurveUpdateProposed and CurveUpdateExecuted contract events.
 * Idempotently upserts into curve_updates table and invalidates cache per key.
 */
export async function processCurveUpdateEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async rawEvent => {
      if (!isCurveUpdateEvent(rawEvent)) {
         return;
      }

      const event = rawEvent as CurveUpdateEventPayload;
      const keyId = event.keyId || event.creatorId || event.key_id;
      if (!keyId || typeof keyId !== 'string') {
         logger.warn(
            { eventType: event.eventType, txHash: event.txHash },
            'Curve update event skipped: missing keyId'
         );
         return;
      }

      const proposalId = String(
         event.proposalId ?? event.proposal_id ?? event.id ?? event.eventIndex
      );

      const upperType = event.eventType.toUpperCase();
      const isProposed = upperType.includes('PROPOSED');
      const isExecuted = upperType.includes('EXECUTED');
      const isCancelled = upperType.includes('CANCELLED');

      const rawParams =
         event.proposedParams ??
         event.proposed_params ??
         event.params ??
         event.curveParams;
      const proposedParams =
         rawParams && typeof rawParams === 'object' ? rawParams : null;

      const rawEta =
         event.eta ??
         event.etaTimestamp ??
         event.executionEta ??
         event.timelockExpiry;
      const eta = parseDate(rawEta);

      const proposer =
         event.proposer || event.proposedBy || (isProposed ? event.actor : null);
      const executor =
         event.executor || event.executedBy || (isExecuted ? event.actor : null);

      const rawExecutedAt =
         event.executedAt ?? event.timestamp ?? (isExecuted ? new Date() : null);
      const executedAt = parseDate(rawExecutedAt);

      let status = 'pending';
      let outcome: string | null = null;
      if (isExecuted) {
         status = 'completed';
         outcome = 'executed';
      } else if (isCancelled) {
         status = 'cancelled';
         outcome = 'cancelled';
      }

      await prisma.curveUpdate.upsert({
         where: {
            keyId_proposalId: {
               keyId,
               proposalId,
            },
         },
         create: {
            keyId,
            proposalId,
            eventType: event.eventType,
            status,
            outcome,
            proposedParams,
            eta,
            proposer: proposer ?? null,
            executor: executor ?? null,
            executedAt,
            ledger: event.ledger ?? 0,
            txHash: event.txHash,
            eventIndex: event.eventIndex ?? 0,
         },
         update: {
            eventType: event.eventType,
            status,
            outcome: outcome ?? undefined,
            ...(proposedParams ? { proposedParams } : {}),
            ...(eta ? { eta } : {}),
            ...(proposer ? { proposer } : {}),
            ...(executor ? { executor } : {}),
            ...(executedAt ? { executedAt } : {}),
            ledger: event.ledger ?? undefined,
            txHash: event.txHash,
            eventIndex: event.eventIndex ?? undefined,
         },
      });

      try {
         await cacheInvalidate(
            `key:curve-updates:pending:${keyId}`,
            `key:curve-updates:history:${keyId}`
         );
      } catch {
         // Non-critical cache error
      }

      logger.info(
         {
            eventType: event.eventType,
            keyId,
            proposalId,
            status,
            txHash: event.txHash,
         },
         `Indexed ${event.eventType} for key ${keyId}`
      );
   });
}
