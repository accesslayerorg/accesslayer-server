import { logger } from '../../utils/logger.utils';
import { OutboxService, OUTBOX_MAX_ATTEMPTS } from './outbox.service';

const BATCH_SIZE = 100;
const POLL_INTERVAL = 5000; // 5 seconds

export class OutboxPublisherWorker {
   private static running = false;
   private static stopCallback: () => void = async () => {};

   static async start(): Promise<void> {
      if (this.running) {
         logger.warn({ message: 'Outbox publisher worker already running' });
         return;
      }
      this.running = true;
      logger.info('Starting outbox publisher worker');

      // Process immediately on startup
      await this.processBatch();

      // Set up interval for periodic processing
      const interval = setInterval(() => this.processBatch(), POLL_INTERVAL);

      // Set the stop callback
      this.stopCallback = () => {
         clearInterval(interval);
         this.running = false;
         logger.info('Outbox publisher worker stopped');
      };
   }

   static async stop(): Promise<void> {
      if (this.stopCallback) {
         this.stopCallback();
      }
   }

   static async processBatch(): Promise<void> {
      try {
         // Fetch unpublished events in batches
         // Use raw query approach to simulate FOR UPDATE SKIP LOCKED
         // In production, we'd use database-level locking
         const events = await OutboxService.getUnpublished(BATCH_SIZE);

         if (events.length === 0) {
            return;
         }

         logger.info({ eventCount: events.length }, 'Processing outbox batch');

         for (const event of events) {
            try {
               // Publish to the internal event bus
               await this.publishEvent(event);

               // Mark as published
               await OutboxService.markPublished(event.id);
            } catch (error) {
               logger.error(
                  {
                     eventId: event.id,
                     attempts: event.attempts,
                     error: error instanceof Error ? error.message : String(error),
                  },
                  'Outbox event publish failed'
               );

               await OutboxService.incrementAttempts(event.id);

               // This failure was attempt number (attempts + 1). Dead-letter it
               // once that reaches the limit; getUnpublished stops returning
               // events at the limit, so this must happen on the failing pass.
               if ((event.attempts || 0) + 1 >= OUTBOX_MAX_ATTEMPTS) {
                  await OutboxService.moveToDeadLetter(event);
               }
            }
         }
      } catch (error) {
         logger.error(
            { error: error instanceof Error ? error.message : String(error) },
            'Outbox batch processing error'
         );
      }
   }

   private static async publishEvent(event: any): Promise<void> {
      const { type } = event;

      // Publish to the internal event bus
      // Dispatch based on event type
      switch (type) {
         case 'order_executable':
            // @todo: emit order executable event
            logger.info({ eventId: event.id, type }, 'Published order executable event');
            break;
         case 'trade_indexed':
            // @todo: emit trade indexed event
            logger.info({ eventId: event.id, type }, 'Published trade indexed event');
            break;
         default:
            logger.info({ eventId: event.id, type }, 'Published outbox event');
      }
   }
}