// src/workers/account-lifecycle.worker.ts
// Background worker for personal data exports and account deletions (#1325).
// Each tick expires old export archives, builds queued exports and anonymizes
// accounts whose deletion grace period has ended. Work is claimed with
// conditional updates, so several instances can run this safely.

import { ACCOUNT_LIFECYCLE_TICK_MS } from '../modules/account/account.constants';
import { processDueDeletions } from '../modules/account/account-deletion.service';
import {
   expireDataExportArchives,
   processDataExportJobs,
} from '../modules/account/data-export.service';
import { logger } from '../utils/logger.utils';

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** Runs one pass. Returns false when skipped (already running) or failed. */
export async function runAccountLifecycleTick(now: Date = new Date()): Promise<boolean> {
   if (running) return false;
   running = true;
   try {
      const expired = await expireDataExportArchives(now);
      const exports = await processDataExportJobs(now);
      const deletions = await processDueDeletions(now);
      if (expired + exports.completed + exports.failed + deletions.completed + deletions.failed > 0) {
         logger.info(
            { expiredExports: expired, exports, deletions },
            'account-lifecycle tick processed work'
         );
      }
      return true;
   } catch (error) {
      logger.error({ err: error }, 'account-lifecycle tick failed');
      return false;
   } finally {
      running = false;
   }
}

export function startAccountLifecycleWorker(): void {
   if (timer) return;
   void runAccountLifecycleTick();
   timer = setInterval(() => {
      void runAccountLifecycleTick();
   }, ACCOUNT_LIFECYCLE_TICK_MS);
   timer.unref?.();
   logger.info('account-lifecycle worker started');
}

export function stopAccountLifecycleWorker(): void {
   if (timer) {
      clearInterval(timer);
      timer = null;
   }
   logger.info('account-lifecycle worker stopped');
}
