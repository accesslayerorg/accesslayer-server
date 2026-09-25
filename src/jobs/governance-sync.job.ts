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
      // Calculate final vote tallies and determine status
      const votes = await prisma.governanceVote.findMany({
        where: { keyId: proposal.keyId, proposalId: proposal.proposalId },
      });

      const totalVotes = votes.reduce((sum: number, vote: any) => sum + Number(vote.weight.toString()), 0);
      const proposalData = await prisma.governanceProposal.findUnique({
        where: { id: proposal.id },
        select: { totalVotingWeight: true, options: true },
      });

      const totalVotingWeight = Number(proposalData?.totalVotingWeight || '0');
      
      // Quorum check: at least 10% of total voting weight must participate
      const quorumMet = totalVotes >= totalVotingWeight * 0.1;
      
      let finalStatus = 'closed';
      if (!quorumMet) {
        finalStatus = 'quorum_not_met';
      } else {
        // Determine passed/failed based on majority option
        const tally: Record<number, number> = {};
        votes.forEach((vote: any) => {
          tally[vote.optionIndex] = (tally[vote.optionIndex] || 0) + Number(vote.weight.toString());
        });
        
        const winningOption = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
        const winningWeight = winningOption ? Number(winningOption[1]) : 0;
        finalStatus = winningWeight > totalVotes / 2 ? 'passed' : 'failed';
      }

      await prisma.governanceProposal.update({
        where: { id: proposal.id },
        data: { status: finalStatus, closedAt: new Date() },
      });
      closed++;
    }
  }

  logger.info({ scanned: activeProposals.length, closed }, 'governanceSync completed');
  return { scanned: activeProposals.length, closed };
}

let governanceTimer: ReturnType<typeof setInterval> | null = null;

export function startGovernanceSyncJob(): void {
  if (!envConfig.GOVERNANCE_SYNC_ENABLED) {
    logger.info('governanceSync job is disabled');
    return;
  }

  const intervalMs = (envConfig.GOVERNANCE_SYNC_INTERVAL_MINUTES ?? 5) * 60 * 1000;

  const run = async () => {
    try {
      await syncGovernanceProposals();
    } catch (error) {
      logger.error({ err: error }, 'governanceSync failed');
    }
  };

  void run();
  governanceTimer = setInterval(() => { void run(); }, intervalMs);

  if (governanceTimer && typeof (governanceTimer as any).unref === 'function') {
    (governanceTimer as any).unref();
  }

  logger.info({ intervalMinutes: envConfig.GOVERNANCE_SYNC_INTERVAL_MINUTES ?? 5 }, 'governanceSync job started');
}

export function stopGovernanceSyncJob(): void {
  if (!governanceTimer) return;
  clearInterval(governanceTimer);
  governanceTimer = null;
  logger.info('governanceSync job stopped');
}
