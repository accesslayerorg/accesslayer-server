import { prisma } from '../../utils/prisma.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';
import {
   IndexerChainEvent,
   processIndexerChainEvents,
} from '../../utils/indexer-event-processor.utils';
import { curveUpdateCacheKeys } from '../keys/curve-updates.service';

export const CURVE_UPDATE_EVENT_TYPES = new Set([
   'CurveUpdateProposed',
   'CURVE_UPDATE_PROPOSED',
   'CurveUpdateExecuted',
   'CURVE_UPDATE_EXECUTED',
]);

const asDate = (value: unknown, fallback = new Date()): Date => {
   if (
      typeof value === 'number' ||
      (typeof value === 'string' && /^\d+$/.test(value))
   ) {
      const n = Number(value);
      const date = new Date(n < 1e12 ? n * 1000 : n);
      if (!Number.isNaN(date.getTime())) return date;
   }
   const date = value ? new Date(String(value)) : fallback;
   return Number.isNaN(date.getTime()) ? fallback : date;
};

export async function processCurveUpdateEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!CURVE_UPDATE_EVENT_TYPES.has(event.eventType)) return;
      const keyId = String(event.keyId ?? event.creatorId ?? '').trim();
      const proposalId = String(
         event.proposalId ?? event.updateId ?? ''
      ).trim();
      if (!keyId || !proposalId)
         throw new Error(
            `Invalid ${event.eventType}: keyId and proposalId are required`
         );

      if (
         event.eventType === 'CurveUpdateProposed' ||
         event.eventType === 'CURVE_UPDATE_PROPOSED'
      ) {
         const eta = asDate(
            event.eta ?? event.executeAfter ?? event.executionTime
         );
         const proposedAt = asDate(
            event.proposedAt ?? event.occurredAt ?? event.timestamp
         );
         const proposedParams =
            event.proposedParams ?? event.params ?? event.parameters;
         if (!proposedParams || typeof proposedParams !== 'object')
            throw new Error(
               `Invalid ${event.eventType}: proposed params are required`
            );
         await prisma.curveUpdate.upsert({
            where: { keyId_proposalId: { keyId, proposalId } },
            create: {
               keyId,
               proposalId,
               proposedParams,
               eta,
               proposedAt,
               proposedTxHash: event.txHash,
               proposedEventIndex: event.eventIndex,
               ledger: Number(event.ledger ?? 0),
            },
            update: {},
         });
      } else {
         const outcome = String(
            event.outcome ??
               event.result ??
               (event.cancelled ? 'cancelled' : 'executed')
         ).toLowerCase();
         const existing = await prisma.curveUpdate.findUnique({
            where: { keyId_proposalId: { keyId, proposalId } },
            select: { executedTxHash: true, executedEventIndex: true },
         });
         if (!existing) {
            throw new Error(
               `${event.eventType} references unknown proposal ${keyId}/${proposalId}`
            );
         }
         if (
            existing.executedTxHash === event.txHash &&
            existing.executedEventIndex === event.eventIndex
         ) {
            await cacheInvalidate(
               curveUpdateCacheKeys.pending(keyId),
               curveUpdateCacheKeys.history(keyId)
            );
            return;
         }
         await prisma.curveUpdate.update({
            where: { keyId_proposalId: { keyId, proposalId } },
            data: {
               status:
                  outcome === 'cancelled' ||
                  outcome === 'canceled' ||
                  event.success === false
                     ? 'cancelled'
                     : 'completed',
               outcome,
               completedAt: asDate(
                  event.executedAt ?? event.occurredAt ?? event.timestamp
               ),
               executedTxHash: event.txHash,
               executedEventIndex: event.eventIndex,
               ledger: Number(event.ledger ?? 0),
            },
         });
      }
      await cacheInvalidate(
         curveUpdateCacheKeys.pending(keyId),
         curveUpdateCacheKeys.history(keyId)
      );
      logger.info(
         { keyId, proposalId, eventType: event.eventType },
         'Curve update event indexed'
      );
   });
}
