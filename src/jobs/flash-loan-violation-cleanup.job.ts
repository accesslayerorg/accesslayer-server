// src/jobs/flash-loan-violation-cleanup.job.ts
// Clears flash loan guard violations that have aged out of the cooldown
// window (FLASH_LOAN_VIOLATION_COOLDOWN_HOURS) and lifts the auto-suspensions
// that were based on the expired history (#938).

import { envConfig } from '../config';
import { logger } from '../utils/logger.utils';
import { clearExpiredFlashLoanViolations } from '../modules/indexer/flash-loan-guard-indexer.service';

let cleanupTimer: NodeJS.Timeout | null = null;

export function startFlashLoanViolationCleanupJob() {
   if (!envConfig.FLASH_LOAN_CLEANUP_ENABLED) {
      logger.info('Flash loan violation cleanup job is disabled');
      return;
   }

   const intervalMs = envConfig.FLASH_LOAN_CLEANUP_INTERVAL_MINUTES * 60 * 1000;

   const run = async () => {
      try {
         const result = await clearExpiredFlashLoanViolations();
         logger.debug(
            {
               cutoff: result.cutoff.toISOString(),
               clearedCount: result.clearedCount,
               liftedSuspensions: result.liftedSuspensions.length,
            },
            'Flash loan violation cleanup pass completed'
         );
      } catch (error) {
         logger.error(
            { err: error },
            'Flash loan violation cleanup failed with an unexpected error'
         );
      }
   };

   void run();
   cleanupTimer = setInterval(() => {
      void run();
   }, intervalMs);

   if (typeof cleanupTimer.unref === 'function') {
      cleanupTimer.unref();
   }

   logger.info(
      {
         intervalMinutes: envConfig.FLASH_LOAN_CLEANUP_INTERVAL_MINUTES,
         cooldownHours: envConfig.FLASH_LOAN_VIOLATION_COOLDOWN_HOURS,
         threshold: envConfig.FLASH_LOAN_VIOLATION_THRESHOLD,
      },
      'Flash loan violation cleanup job started'
   );
}

export function stopFlashLoanViolationCleanupJob() {
   if (!cleanupTimer) {
      return;
   }

   clearInterval(cleanupTimer);
   cleanupTimer = null;
   logger.info('Flash loan violation cleanup job stopped');
}
