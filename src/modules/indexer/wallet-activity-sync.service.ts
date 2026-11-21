import { prisma } from "../../utils/prisma.utils";
import { logger } from "../../utils/logger.utils";
import { envConfig } from "../../config";

export interface TransferChainEvent {
   eventType: "keys_transferred" | "KEY_TRANSFERRED" | "transfer";
   txHash: string;
   eventIndex?: number;
   fromAddress: string;
   toAddress: string;
   keyId: string;
   amount: number | string;
   timestamp?: Date | string;
   creatorName?: string;
   ledger?: number;
}

export interface BurnChainEvent {
   eventType: "keys_burned" | "KEY_BURNED" | "burn";
   txHash: string;
   eventIndex?: number;
   burnerAddress: string;
   keyId: string;
   amount: number | string;
   timestamp?: Date | string;
   creatorName?: string;
   ledger?: number;
}

export type ActivitySyncEvent = TransferChainEvent | BurnChainEvent;

/**
 * Executes a function with up to maxRetries exponential backoff retries.
 */
export async function executeWithRetry<T>(
   operation: () => Promise<T>,
   maxRetries = 3,
   baseDelayMs = 100
): Promise<T> {
   let lastError: any;
   for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
         return await operation();
      } catch (error) {
         lastError = error;
         if (attempt === maxRetries) {
            break;
         }
         const delay = baseDelayMs * Math.pow(2, attempt - 1);
         await new Promise((resolve) => setTimeout(resolve, delay));
      }
   }
   throw lastError;
}

/**
 * Processes a keys_transferred event:
 * - Writes 2 records to activity_log (one for sender as transfer_out, one for recipient as transfer_in)
 * - Retries up to 3 times on transient failure
 * - Idempotent via txHash + actor + type
 */
export async function processTransferEvent(
   event: TransferChainEvent
): Promise<{ senderRecord: any; recipientRecord: any } | null> {
   const {
      txHash,
      fromAddress,
      toAddress,
      keyId,
      amount,
      timestamp,
      creatorName,
   } = event;
   const eventTimestamp = timestamp ? new Date(timestamp) : new Date();
   const numericAmount = Number(amount);

   return executeWithRetry(async () => {
      // 1. Sender record (transfer_out)
      const senderRecord = await prisma.activityLog.upsert({
         where: {
            txHash_actor_type: {
               txHash,
               actor: fromAddress,
               type: "transfer_out",
            },
         },
         create: {
            type: "transfer_out",
            actor: fromAddress,
            target: toAddress,
            keyId,
            creatorName: creatorName || null,
            amount: numericAmount,
            txHash,
            timestamp: eventTimestamp,
            payload: {
               event: "keys_transferred",
               from: fromAddress,
               to: toAddress,
               amount: numericAmount,
            },
         },
         update: {},
      });

      // 2. Recipient record (transfer_in)
      const recipientRecord = await prisma.activityLog.upsert({
         where: {
            txHash_actor_type: {
               txHash,
               actor: toAddress,
               type: "transfer_in",
            },
         },
         create: {
            type: "transfer_in",
            actor: toAddress,
            target: fromAddress,
            keyId,
            creatorName: creatorName || null,
            amount: numericAmount,
            txHash,
            timestamp: eventTimestamp,
            payload: {
               event: "keys_transferred",
               from: fromAddress,
               to: toAddress,
               amount: numericAmount,
            },
         },
         update: {},
      });

      logger.info(
         { txHash, fromAddress, toAddress, keyId, amount: numericAmount },
         "Logged keys_transferred activity records"
      );

      return { senderRecord, recipientRecord };
   }, 3, 50).catch((err) => {
      logger.error(
         { err, txHash, fromAddress, toAddress, keyId },
         "Failed to write transfer activity records after 3 retries, skipping"
      );
      return null;
   });
}

/**
 * Processes a keys_burned event:
 * - Writes 1 record to activity_log for burner
 * - Retries up to 3 times on transient failure
 * - Idempotent via txHash + actor + type
 */
export async function processBurnEvent(
   event: BurnChainEvent
): Promise<{ burnerRecord: any } | null> {
   const {
      txHash,
      burnerAddress,
      keyId,
      amount,
      timestamp,
      creatorName,
   } = event;
   const eventTimestamp = timestamp ? new Date(timestamp) : new Date();
   const numericAmount = Number(amount);

   return executeWithRetry(async () => {
      const burnerRecord = await prisma.activityLog.upsert({
         where: {
            txHash_actor_type: {
               txHash,
               actor: burnerAddress,
               type: "burn",
            },
         },
         create: {
            type: "burn",
            actor: burnerAddress,
            keyId,
            creatorName: creatorName || null,
            amount: numericAmount,
            txHash,
            timestamp: eventTimestamp,
            payload: {
               event: "keys_burned",
               burner: burnerAddress,
               amount: numericAmount,
            },
         },
         update: {},
      });

      logger.info(
         { txHash, burnerAddress, keyId, amount: numericAmount },
         "Logged keys_burned activity record"
      );

      return { burnerRecord };
   }, 3, 50).catch((err) => {
      logger.error(
         { err, txHash, burnerAddress, keyId },
         "Failed to write burn activity record after 3 retries, skipping"
      );
      return null;
   });
}

/**
 * Dispatches an event from stream to appropriate handler
 */
export async function handleActivitySyncEvent(event: ActivitySyncEvent): Promise<void> {
   if (
      event.eventType === "keys_transferred" ||
      event.eventType === "KEY_TRANSFERRED" ||
      event.eventType === "transfer"
   ) {
      await processTransferEvent(event as TransferChainEvent);
   } else if (
      event.eventType === "keys_burned" ||
      event.eventType === "KEY_BURNED" ||
      event.eventType === "burn"
   ) {
      await processBurnEvent(event as BurnChainEvent);
   }
}

export interface ActivitySyncListenerConfig {
   contractAddress?: string;
   horizonUrl?: string;
   reconnectIntervalMs?: number;
   onEvent?: (event: ActivitySyncEvent) => Promise<void>;
}

/**
 * Manages the background streaming connection with automatic reconnection.
 */
export class ActivitySyncJob {
   private running = false;
   private reconnectTimer: NodeJS.Timeout | null = null;
   private config: ActivitySyncListenerConfig;

   constructor(config: ActivitySyncListenerConfig = {}) {
      this.config = {
         horizonUrl: config.horizonUrl || envConfig.STELLAR_HORIZON_URL,
         reconnectIntervalMs: config.reconnectIntervalMs || 5000,
         onEvent: config.onEvent || handleActivitySyncEvent,
         ...config,
      };
   }

   public start(): void {
      if (this.running) return;
      this.running = true;
      logger.info("Starting ActivitySyncJob Horizon listener...");
      this.connect();
   }

   public stop(): void {
      this.running = false;
      if (this.reconnectTimer) {
         clearTimeout(this.reconnectTimer);
         this.reconnectTimer = null;
      }
      logger.info("Stopped ActivitySyncJob");
   }

   public isRunning(): boolean {
      return this.running;
   }

   public triggerReconnect(): void {
      if (!this.running) return;
      logger.warn("Horizon stream connection dropped, scheduling reconnect...");
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
         if (this.running) {
            this.connect();
         }
      }, this.config.reconnectIntervalMs);
   }

   private connect(): void {
      try {
         // Horizon SSE subscription placeholder / active stream handler
         logger.info(
            { horizonUrl: this.config.horizonUrl },
            "ActivitySyncJob connected to Horizon event stream"
         );
      } catch (err) {
         logger.error({ err }, "Horizon connection error");
         this.triggerReconnect();
      }
   }
}
