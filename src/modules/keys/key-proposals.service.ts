// src/modules/keys/key-proposals.service.ts
import { prisma } from '../../utils/prisma.utils';

export class KeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundError';
   }
}

export type ProposalStatus = 'active' | 'closed';

export interface Proposal {
   proposalId: string;
   title: string;
   options: string[];
   totalVotingWeight: string;
   results: Record<string, string>;
   snapshotLedger: number;
   expiresAt: Date;
   closedAt: Date | null;
   status: ProposalStatus;
}

export async function getKeyProposals(
   keyId: string,
   status?: ProposalStatus
): Promise<Proposal[]> {
   const creator = await prisma.creatorProfile.findUnique({
      where: { id: keyId },
      select: { id: true },
   });
   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const where: Record<string, unknown> = { keyId };
   if (status) {
      where.status = status;
   }

   const proposals = await prisma.governanceProposal.findMany({
      where,
      orderBy:
         status === 'closed' ? { closedAt: 'desc' } : { expiresAt: 'asc' },
   });

   return proposals.map(p => ({
      proposalId: p.proposalId,
      title: p.title,
      options: p.options as string[],
      totalVotingWeight: p.totalVotingWeight,
      results: p.results as Record<string, string>,
      snapshotLedger: p.snapshotLedger,
      expiresAt: p.expiresAt,
      closedAt: p.closedAt,
      status: p.status as ProposalStatus,
   }));
}
export async function getProposalForVoting(
   keyId: string,
   proposalId: string
): Promise<{ exists: boolean; status?: ProposalStatus; options?: string[] }> {
   const proposal = await prisma.governanceProposal.findFirst({
      where: {
         keyId,
         proposalId,
      },
      select: {
         status: true,
         options: true,
      },
   });

   if (!proposal) {
      return { exists: false };
   }

   return {
      exists: true,
      status: proposal.status as ProposalStatus,
      options: proposal.options as string[],
   };
}
