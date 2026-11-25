import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';

export interface OutboxEvent {
   id: string;
   type: string;
   payload: unknown;
   createdAt: Date;
   publishedAt: Date | null;
   attempts: number;
   priority?: OutboxPriority;
}

/** Publish attempts before an event is dead-lettered. */
export const OUTBOX_MAX_ATTEMPTS = 10;

/** Marker written to attempts once an event has been dead-lettered. */
export const OUTBOX_DEAD_LETTER_ATTEMPTS = 999;

/** Maximum bulk events fetched per poll cycle so bulk work never fills a batch. */
export const OUTBOX_BULK_FETCH_LIMIT = 10;

export type OutboxPriority = 'critical' | 'normal' | 'bulk';

const CRITICAL_TYPE_PREFIXES = ['settlement', 'order_fill', 'alert'];
const BULK_TYPE_PREFIXES = ['bulk_', 'backfill'];

/**
 * Priority for an outbox event type (#1341). Settlements, order fills and
 * alerts are critical. Explicitly bulk work is bulk. Everything else is normal.
 */
export function priorityForOutboxType(type: string): OutboxPriority {
   const normalized = type.toLowerCase();
   if (CRITICAL_TYPE_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
      return 'critical';
   }
   if (BULK_TYPE_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
      return 'bulk';
   }
   return 'normal';
}

export class OutboxService {
   /**
    * Enqueue an event into the outbox within a Prisma transaction.
    * The event will be published by the OutboxPublisherWorker.
    *
    * @param tx - Prisma transaction instance
    * @param type - Event type string
    * @param payload - Event payload object
    * @param priority - Optional override; defaults to priorityForOutboxType(type)
    * @returns The outbox event ID
    */
   static async enqueue(
      tx: typeof prisma,
      type: string,
      payload: unknown,
      priority: OutboxPriority = priorityForOutboxType(type)
   ): Promise<string> {
      const id = crypto.randomUUID();
      await tx.outboxEvent.create({
         data: {
            id,
            type,
            payload: JSON.stringify(payload),
            priority,
         },
      });
      return id;
   }

   /**
    * Get unpublished events that still have publish attempts left.
    *
    * Critical events are always fetched first and fill the batch before normal
    * events. Bulk events are capped at OUTBOX_BULK_FETCH_LIMIT per call, so a
    * large bulk backlog cannot starve critical or normal work. Rows are not
    * row-locked: run one publisher per deployment.
    */
   static async getUnpublished(limit = 100) {
      const orderBy: Prisma.OutboxEventOrderByWithRelationInput[] = [
         { createdAt: 'asc' },
      ];
      const eligible = (priority: OutboxPriority, take: number) =>
         prisma.outboxEvent.findMany({
            where: {
               publishedAt: null,
               attempts: { lt: OUTBOX_MAX_ATTEMPTS },
               priority,
            },
            orderBy,
            take,
         });

      const critical = await eligible('critical', limit);
      const normalTake = Math.max(0, limit - critical.length);
      const normal = normalTake > 0 ? await eligible('normal', normalTake) : [];
      const bulkTake = Math.min(
         OUTBOX_BULK_FETCH_LIMIT,
         Math.max(0, limit - critical.length - normal.length)
      );
      const bulk = bulkTake > 0 ? await eligible('bulk', bulkTake) : [];

      return [...critical, ...normal, ...bulk];
   }

   /**
    * Mark an outbox event as published and set publishedAt.
    * Also increments the attempts counter.
    */
   static async markPublished(id: string): Promise<void> {
      await prisma.outboxEvent.update({
         where: { id },
         data: {
            publishedAt: new Date(),
            attempts: {
               increment: 1,
            },
         },
      });
   }

   /**
    * Increment the attempts counter for a failed event.
    */
   static async incrementAttempts(id: string): Promise<void> {
      await prisma.outboxEvent.update({
         where: { id },
         data: {
            attempts: {
               increment: 1,
            },
         },
      });
   }

   /**
    * Dead-letter an event that exhausted its publish attempts (#1341).
    *
    * The event is marked so polling stops picking it up, and a row is written
    * to the indexer DLQ table in the same transaction. Admins can then inspect
    * and replay it through /v1/admin/dlq.
    */
   static async moveToDeadLetter(
      event: Pick<OutboxEvent, 'id' | 'type' | 'payload' | 'attempts'>
   ): Promise<void> {
      await prisma.$transaction(async tx => {
         await tx.outboxEvent.update({
            where: { id: event.id },
            data: { attempts: OUTBOX_DEAD_LETTER_ATTEMPTS },
         });

         await tx.indexerDLQ.create({
            data: {
               jobType: `outbox:${event.type}`,
               payload: {
                  outboxEventId: event.id,
                  type: event.type,
                  payload: event.payload,
               } as Prisma.InputJsonValue,
               retryCount: event.attempts + 1,
               failureReason: `Outbox publish failed after ${OUTBOX_MAX_ATTEMPTS} attempts`,
            },
         });
      });
   }
}
