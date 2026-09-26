// src/jobs/governance-sync.job.ts
import { envConfig } from '../config';
import { logger } from '../utils/logger.utils';
import { prisma } from '../utils/prisma.utils';

export async function syncGovernanceProposals() {
   const activeProposals = await prisma.governanceProposal.findMany({
      where: { status: 'active' },
      select: { id: true, keyId: true, proposalId: true, expiresAt: true },
   });

   let closed = 0;
   for (const proposal of activeProposals) {
      if (new Date() > proposal.expiresAt) {
         await prisma.governanceProposal.update({
            where: { id: proposal.id },
            data: { status: 'closed', closedAt: new Date() },
         });
         closed++;
      }
   }

   logger.info(
      { scanned: activeProposals.length, closed },
      'governanceSync completed'
   );
   return { scanned: activeProposals.length, closed };
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
