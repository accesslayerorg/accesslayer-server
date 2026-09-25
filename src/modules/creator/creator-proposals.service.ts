// src/modules/creator/creator-proposals.service.ts
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { CreateProposalInput } from './creator-proposals.schemas';

export class KeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundError';
   }
}

export interface CreatedProposalResult {
   id: string;
   keyId: string;
   proposalId: string;
   title: string;
   options: string[];
   totalVotingWeight: string;
   results: Record<string, string>;
   snapshotLedger: number;
   durationLedgerUnits: number;
   expiresAt: Date;
   status: string;
   createdAt: Date;
}

// Stellar / Soroban ledgers close roughly every 5 seconds (~17,280 ledgers per day)
export const LEDGERS_PER_DAY = 17280;

/**
 * Calculate the total voting weight from staked balances at proposal creation time.
 * This implements the snapshot voting mechanism from issue #878.
 */
async function calculateSnapshotVotingWeight(keyId: string): Promise<string> {
   const stakingPositions = await prisma.stakingPosition.findMany({
      where: {
         keyId,
         amount: { not: '0' },
         lockedUntil: { gt: new Date() }, // Only active locks
      },
      select: { amount: true },
   });

   const totalWeight = stakingPositions.reduce(
      (sum: bigint, pos: any) => sum + BigInt(pos.amount.toString()),
      0n
   );

   return totalWeight.toString();
}

export async function createCreatorProposal(
   keyId: string,
   creatorWallet: string,
   input: CreateProposalInput
): Promise<CreatedProposalResult> {
   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: { id: true },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const resolvedKeyId = creator.id;
   const { title, options, durationDays } = input;

   const durationLedgerUnits = durationDays * LEDGERS_PER_DAY;
   const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);
   const proposalId = `prop-${resolvedKeyId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

   const initialResults: Record<string, string> = {};
   for (const option of options) {
      initialResults[option] = '0';
   }

   // Calculate snapshot voting weight from staked balances
   const snapshotVotingWeight = await calculateSnapshotVotingWeight(resolvedKeyId);

   // Simulated contract call submit: create_proposal on Soroban
   logger.info(
      {
         operation: 'create_proposal_contract_call',
         keyId: resolvedKeyId,
         proposalId,
         durationDays,
         durationLedgerUnits,
         snapshotVotingWeight,
      },
      'Submitting create_proposal contract call'
   );

   const proposal = await prisma.governanceProposal.create({
      data: {
         keyId: resolvedKeyId,
         proposalId,
         title,
         options,
         totalVotingWeight: snapshotVotingWeight,
         results: initialResults,
         snapshotLedger: 0, // Will be updated with actual ledger from contract
         expiresAt,
         status: 'active',
      },
   });

   // Record activity audit event
   await prisma.activity.create({
      data: {
         type: 'GOVERNANCE_PROPOSAL_CREATED',
         actor: creatorWallet,
         creatorId: resolvedKeyId,
         payload: {
            proposalId: proposal.proposalId,
            title,
            options,
            durationDays,
            durationLedgerUnits,
            expiresAt: expiresAt.toISOString(),
            snapshotVotingWeight,
         },
      },
   });

   return {
      id: proposal.id,
      keyId: proposal.keyId,
      proposalId: proposal.proposalId,
      title: proposal.title,
      options: proposal.options as string[],
      totalVotingWeight: proposal.totalVotingWeight,
      results: proposal.results as Record<string, string>,
      snapshotLedger: proposal.snapshotLedger,
      durationLedgerUnits,
      expiresAt: proposal.expiresAt,
      status: proposal.status,
      createdAt: proposal.createdAt,
   };
}
