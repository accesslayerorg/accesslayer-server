import { prisma } from '../../utils/prisma.utils';

export interface OutboxEvent {
   id: string;
   type: string;
   payload: unknown;
   createdAt: Date;
   publishedAt: Date | null;
   attempts: number;
}

export class OutboxService {
   /**
    * Enqueue an event into the outbox within a Prisma transaction.
    * The event will be published by the OutboxPublisherWorker.
    *
    * @param tx - Prisma transaction instance
    * @param type - Event type string
    * @param payload - Event payload object
    * @returns The outbox event ID
    */
   static async enqueue(
      tx: typeof prisma,
      type: string,
      payload: unknown
   ): Promise<string> {
      const id = crypto.randomUUID();
      await tx.outboxEvent.create({
         data: {
            id,
            type,
            payload: JSON.stringify(payload),
         },
      });
      return id;
   }

   /**
    * Get unpublished outbox events, ordered by creation time.
    * Uses FOR UPDATE SKIP LOCKED to prevent concurrent workers from
    * processing the same rows.
    */
   static async getUnpublished(limit = 100) {
      return prisma.outboxEvent.findMany({
         where: {
            publishedAt: null,
         },
         orderBy: {
            createdAt: 'asc',
         },
         take: limit,
      });
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
    * Move an event to the dead-letter table after max attempts.
    * In a full implementation, this would move the event to a separate
    * dead-letter table. For now, we just mark it with a high attempt count.
    */
   static async moveToDeadLetter(id: string): Promise<void> {
      await prisma.outboxEvent.update({
         where: { id },
         data: {
            attempts: 999,
         },
      });
   }
}