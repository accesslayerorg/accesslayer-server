// src/modules/keys/key-proposal-votes.service.ts
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { Decimal } from '@prisma/client/runtime/library';

export class HolderNotEligibleError extends Error {
   constructor(wallet: string) {
      super(`Wallet ${wallet} holds no keys and is not eligible to vote`);
      this.name = 'HolderNotEligibleError';
   }
}

export class DuplicateVoteError extends Error {
   constructor() {
      super('Wallet has already voted on this proposal');
      this.name = 'DuplicateVoteError';
   }
}

export class OptionIndexOutOfRangeError extends Error {
   constructor(optionIndex: number, optionCount: number) {
      super(
         `optionIndex ${optionIndex} is out of range; proposal has ${optionCount} options`
      );
      this.name = 'OptionIndexOutOfRangeError';
   }
}

export interface CastVoteResult {
   proposalId: string;
   optionIndex: number;
   option: string;
   weight: string;
}

/**
 * Load the proposal so the route can map outcomes to the correct HTTP
 * status codes (404 for missing/closed, 409 for duplicates, 422 for invalid
 * option index, 403 for non-holders).
 */
export async function getProposalForVoting(
   keyId: string,
   proposalId: string
): Promise<{
   exists: boolean;
   status?: 'active' | 'closed';
   options?: string[];
}> {
   const proposal = await prisma.governanceProposal.findFirst({
      where: { keyId, proposalId },
   });

   if (!proposal) {
      return { exists: false };
   }

   return {
      exists: true,
      status: proposal.status as 'active' | 'closed',
      options: proposal.options as string[],
   };
}

/**
 * Check whether a wallet has already voted on a proposal.
 */
export async function hasWalletVoted(
   keyId: string,
   proposalId: string,
   wallet: string
): Promise<boolean> {
   const vote = await prisma.governanceVote.findUnique({
      where: {
         keyId_proposalId_voter: { keyId, proposalId, voter: wallet },
      },
   });
   return !!vote;
}

/**
 * Submit a governance vote on behalf of a key holder and persist it.
 *
 * The voter's key balance becomes the vote weight. The vote record is
 * written to the `proposal_votes` table; a duplicate vote surfaces as a
 * Prisma unique constraint violation mapped by the route to 409.
 */
export async function castKeyProposalVote(
   keyId: string,
   proposalId: string,
   optionIndex: number,
   wallet: string
): Promise<CastVoteResult> {
   const existing = await getProposalForVoting(keyId, proposalId);
   if (!existing.exists) {
      const err = new Error('Proposal not found or closed');
      err.name = 'ProposalNotFoundOrClosedError';
      throw err;
   }

   const options = existing.options ?? [];
   if (optionIndex < 0 || optionIndex >= options.length) {
      throw new OptionIndexOutOfRangeError(optionIndex, options.length);
   }

   const ownership = await prisma.keyOwnership.findUnique({
      where: {
         ownerAddress_creatorId: { ownerAddress: wallet, creatorId: keyId },
      },
   });

   const balance = ownership ? Number(ownership.balance) : 0;
   if (balance <= 0) {
      throw new HolderNotEligibleError(wallet);
   }

   const alreadyVoted = await hasWalletVoted(keyId, proposalId, wallet);
   if (alreadyVoted) {
      throw new DuplicateVoteError();
   }

   const weight = String(balance);

   // TODO: submit cast_vote contract call via Stellar SDK
   // On-chain failure should return 502 before reaching this point.
   logger.info(
      {
         operation: 'cast_vote',
         keyId,
         proposalId,
         voter: wallet,
         optionIndex,
         option: options[optionIndex],
         weight,
      },
      'Submitting cast_vote contract call'
   );

   await prisma.$transaction([
      prisma.governanceVote.create({
         data: {
            keyId,
            proposalId,
            voter: wallet,
            optionIndex,
            weight: new Decimal(weight),
         },
      }),
      prisma.activity.create({
         data: {
            type: 'GOVERNANCE_PROPOSAL_CREATED',
            actor: wallet,
            creatorId: keyId,
            payload: {
               keyId,
               proposalId,
               action: 'vote_cast',
               optionIndex,
               option: options[optionIndex],
               weight,
            },
         },
      }),
   ]);

   return {
      proposalId,
      optionIndex,
      option: options[optionIndex],
      weight,
   };
}
