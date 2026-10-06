// src/modules/governance/governance-escalation.service.ts
//
// Governance proposal quorum escalation tracking (#935): proposals currently
// in escalation, with extended deadline, escalation count, and participation
// rate (sum of GovernanceVote.weight for the proposal / totalVotingWeight).

import { prisma } from '../../utils/prisma.utils';
import { paginateQuery } from '../../utils/pagination.utils';

export const ESCALATING_PROPOSALS_PAGE_SIZE = 20;

export interface EscalatingProposalItem {
   keyId: string;
   proposalId: string;
   title: string;
   status: string;
   escalationCount: number;
   maxEscalations: number;
   originalDeadline: string | null;
   extendedDeadline: string | null;
   escalatedAt: string | null;
   /**
    * Sum of cast vote weight divided by totalVotingWeight, as a number in
    * [0, 1]. `null` when totalVotingWeight is zero (rate undefined).
    */
   participationRate: number | null;
}

async function computeParticipationRate(
   keyId: string,
   proposalId: string,
   totalVotingWeight: string
): Promise<number | null> {
   const total = Number(totalVotingWeight);
   if (!Number.isFinite(total) || total <= 0) {
      return null;
   }

   const votes = await prisma.governanceVote.aggregate({
      where: { keyId, proposalId },
      _sum: { weight: true },
   });

   const castWeight = Number(votes._sum.weight ?? 0);
   return castWeight / total;
}

/**
 * Fetches proposals currently in escalation: escalationCount > 0 and
 * status = 'active', cursor-paginated, most recently escalated first.
 */
export async function getEscalatingProposals(cursor?: string): Promise<{
   items: EscalatingProposalItem[];
   next_cursor: string | null;
   has_more: boolean;
}> {
   const { data, nextCursor, hasMore } = await paginateQuery(
      args =>
         prisma.governanceProposal.findMany({
            where: { escalationCount: { gt: 0 }, status: 'active' },
            orderBy: { escalatedAt: 'desc' },
            ...args,
         }),
      {
         cursor: cursor ? { id: cursor } : undefined,
         limit: ESCALATING_PROPOSALS_PAGE_SIZE,
      }
   );

   const items: EscalatingProposalItem[] = await Promise.all(
      data.map(async proposal => ({
         keyId: proposal.keyId,
         proposalId: proposal.proposalId,
         title: proposal.title,
         status: proposal.status,
         escalationCount: proposal.escalationCount,
         maxEscalations: proposal.maxEscalations,
         originalDeadline: proposal.originalDeadline
            ? proposal.originalDeadline.toISOString()
            : null,
         extendedDeadline: proposal.extendedDeadline
            ? proposal.extendedDeadline.toISOString()
            : null,
         escalatedAt: proposal.escalatedAt
            ? proposal.escalatedAt.toISOString()
            : null,
         participationRate: await computeParticipationRate(
            proposal.keyId,
            proposal.proposalId,
            proposal.totalVotingWeight
         ),
      }))
   );

   return {
      items,
      next_cursor: hasMore ? (nextCursor ?? null) : null,
      has_more: hasMore,
   };
}
