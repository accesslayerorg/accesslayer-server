import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   ISorobanClient,
   RecoverySummary,
   RecoveryWorkerOptions,
} from './wal.types';
import { defaultSorobanClient } from './soroban-client';
import { SorobanWALService, sorobanWALService } from './wal.service';

let recoveryIntervalTimer: NodeJS.Timeout | null = null;
let isRecoveryRunning = false;

export class WALRecoveryWorker {
   constructor(
      private prisma: PrismaClient = defaultPrisma,
      private walService: SorobanWALService = sorobanWALService,
      private sorobanClient: ISorobanClient = defaultSorobanClient
   ) {}

   /**
    * Scans for stale WAL entries and executes crash recovery:
    * - PENDING entries older than ageThresholdMs: marked as ROLLED_BACK (never submitted)
    * - SUBMITTED entries older than ageThresholdMs: queried against Horizon:
    *   - If confirmed: applies database side effects and marks CONFIRMED
    *   - If failed: marks FAILED with error
    *   - If still pending: re-polls up to 10 times with exponential backoff before marking FAILED
    */
   async runRecovery(
      options?: RecoveryWorkerOptions
   ): Promise<RecoverySummary> {
      const ageThresholdMs = options?.ageThresholdMs ?? 30000; // 30 seconds default
      const maxPollAttempts = options?.maxPollAttempts ?? 10;
      const baseBackoffMs = options?.baseBackoffMs ?? 50;

      const thresholdDate = new Date(Date.now() - ageThresholdMs);

      const summary: RecoverySummary = {
         scannedCount: 0,
         rolledBackCount: 0,
         confirmedCount: 0,
         failedCount: 0,
         stillPendingCount: 0,
         skippedIdempotentCount: 0,
      };

      try {
         // Find entries in PENDING or SUBMITTED state older than 30 seconds
         const staleEntries = await this.prisma.sorobanWALEntry.findMany({
            where: {
               state: { in: ['PENDING', 'SUBMITTED'] },
               OR: [
                  { createdAt: { lte: thresholdDate } },
                  { submittedAt: { lte: thresholdDate } },
               ],
            },
            orderBy: { createdAt: 'asc' },
         });

         summary.scannedCount = staleEntries.length;

         if (staleEntries.length > 0) {
            logger.info(
               `WAL Recovery Worker found ${staleEntries.length} stale entries to reconcile`
            );
         }

         for (const entry of staleEntries) {
            if (entry.state === 'PENDING') {
               // Transaction was never submitted on-chain before crash — roll back
               await this.prisma.sorobanWALEntry.update({
                  where: { id: entry.id },
                  data: {
                     state: 'ROLLED_BACK',
                     error: 'Transaction rolled back by recovery worker: never submitted',
                  },
               });

               summary.rolledBackCount++;
               logger.info(
                  `WAL recovery: rolled back unsubmitted PENDING entry ${entry.id}`
               );
            } else if (entry.state === 'SUBMITTED') {
               if (!entry.txHash) {
                  // Edge case: marked SUBMITTED but without hash -> fail
                  await this.prisma.sorobanWALEntry.update({
                     where: { id: entry.id },
                     data: {
                        state: 'FAILED',
                        error: 'Stale SUBMITTED entry missing txHash',
                     },
                  });
                  summary.failedCount++;
                  continue;
               }

               // Query Horizon for transaction result
               const initialResult =
                  await this.sorobanClient.getTransactionResult(entry.txHash);

               if (initialResult.status === 'SUCCESS') {
                  const { applied } =
                     await this.walService.applyConfirmedSideEffects(
                        entry.txHash
                     );
                  if (applied) {
                     summary.confirmedCount++;
                  } else {
                     summary.skippedIdempotentCount++;
                  }
                  logger.info(
                     `WAL recovery: confirmed SUBMITTED entry ${entry.id} (tx: ${entry.txHash})`
                  );
               } else if (initialResult.status === 'FAILED') {
                  await this.prisma.sorobanWALEntry.update({
                     where: { id: entry.id },
                     data: {
                        state: 'FAILED',
                        error:
                           initialResult.error || 'Transaction failed on-chain',
                     },
                  });
                  summary.failedCount++;
                  logger.info(
                     `WAL recovery: marked SUBMITTED entry ${entry.id} FAILED (tx: ${entry.txHash})`
                  );
               } else {
                  // Still pending: re-poll up to 10 times with exponential backoff
                  logger.info(
                     `WAL recovery: tx ${entry.txHash} still pending, re-polling up to ${maxPollAttempts} times`
                  );

                  const pollResult =
                     await this.walService.pollHorizonForConfirmation(
                        entry.txHash,
                        maxPollAttempts,
                        baseBackoffMs
                     );

                  if (pollResult.status === 'SUCCESS') {
                     const { applied } =
                        await this.walService.applyConfirmedSideEffects(
                           entry.txHash
                        );
                     if (applied) {
                        summary.confirmedCount++;
                     } else {
                        summary.skippedIdempotentCount++;
                     }
                  } else if (pollResult.status === 'FAILED') {
                     await this.prisma.sorobanWALEntry.update({
                        where: { id: entry.id },
                        data: {
                           state: 'FAILED',
                           error:
                              pollResult.error ||
                              'Transaction failed on-chain during re-poll',
                        },
                     });
                     summary.failedCount++;
                  } else {
                     // Still pending after 10 re-polls: mark as FAILED
                     await this.prisma.sorobanWALEntry.update({
                        where: { id: entry.id },
                        data: {
                           state: 'FAILED',
                           error: `Transaction still unconfirmed after ${maxPollAttempts} re-poll attempts`,
                        },
                     });
                     summary.failedCount++;
                  }
               }
            }
         }
      } catch (error: any) {
         logger.error(
            { error: error.message },
            'Error in WAL recovery execution'
         );
         throw error;
      }

      return summary;
   }
}

export const defaultWALRecoveryWorker = new WALRecoveryWorker();

/**
 * Starts the recovery worker:
 * - Runs once on startup
 * - Runs periodically every 60 seconds
 */
export async function startWALRecoveryWorker(
   intervalMs = 60000,
   options?: RecoveryWorkerOptions
): Promise<void> {
   // Run once immediately on startup
   try {
      logger.info('Running initial WAL recovery scan on startup');
      await defaultWALRecoveryWorker.runRecovery(options);
   } catch (error: any) {
      logger.error(
         { error: error.message },
         'Startup WAL recovery scan encountered an error'
      );
   }

   // Clear existing interval if already scheduled
   if (recoveryIntervalTimer) {
      clearInterval(recoveryIntervalTimer);
   }

   // Schedule periodic recovery every 60 seconds
   recoveryIntervalTimer = setInterval(async () => {
      if (isRecoveryRunning) {
         logger.debug(
            'WAL recovery cycle skipped: previous run still in progress'
         );
         return;
      }

      isRecoveryRunning = true;
      try {
         await defaultWALRecoveryWorker.runRecovery(options);
      } catch (error: any) {
         logger.error(
            { error: error.message },
            'Periodic WAL recovery run failed'
         );
      } finally {
         isRecoveryRunning = false;
      }
   }, intervalMs);

   // Unref timer so it does not prevent node process from exiting cleanly in tests/scripts
   recoveryIntervalTimer.unref();

   logger.info(
      `WAL Recovery Worker scheduled to run every ${intervalMs / 1000} seconds`
   );
}

/**
 * Stops the scheduled recovery worker interval.
 */
export function stopWALRecoveryWorker(): void {
   if (recoveryIntervalTimer) {
      clearInterval(recoveryIntervalTimer);
      recoveryIntervalTimer = null;
      logger.info('WAL Recovery Worker stopped');
   }
}
