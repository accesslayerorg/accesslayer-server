// src/jobs/governance-sync.job.ts
import { envConfig } from '../config';
import { logger } from '../utils/logger.utils';
import { closeDueProposals } from '../modules/governance/governance-proposals.service';

/**
 * Close every active proposal whose deadline has passed, computing the quorum
 * outcome (passed / failed / quorum_not_met) for each (#878).
 */
export async function syncGovernanceProposals() {
   const { scanned, closed, outcomes } = await closeDueProposals();

   logger.info({ scanned, closed, outcomes }, 'governanceSync completed');
   return { scanned, closed, outcomes };
}

let governanceTimer: ReturnType<typeof setInterval> | null = null;

export function startGovernanceSyncJob(): void {
   if (!envConfig.GOVERNANCE_SYNC_ENABLED) {
      logger.info('governanceSync job is disabled');
      return;
   }

   const intervalMs =
      (envConfig.GOVERNANCE_SYNC_INTERVAL_MINUTES ?? 5) * 60 * 1000;

   const run = async () => {
      try {
         await syncGovernanceProposals();
      } catch (error) {
         logger.error({ err: error }, 'governanceSync failed');
      }
   };

   void run();
   governanceTimer = setInterval(() => {
      void run();
   }, intervalMs);

   if (typeof (governanceTimer as any).unref === 'function') {
      governanceTimer.unref();
   }

   logger.info(
      { intervalMinutes: envConfig.GOVERNANCE_SYNC_INTERVAL_MINUTES ?? 5 },
      'governanceSync job started'
   );
}

export function stopGovernanceSyncJob(): void {
   if (!governanceTimer) return;
   clearInterval(governanceTimer);
   governanceTimer = null;
   logger.info('governanceSync job stopped');
}
