// src/modules/keys/key-proposal-votes.service.ts
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { Decimal } from '@prisma/client/runtime/library';
import { getDelegatedVoteWeight } from '../governance/governance-delegation.service';

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

/**
 * Denormalised tally currently stored on a GovernanceProposal row.
 */
export interface ProposalTotals {
   totalVotingWeight: string;
   results: Record<string, string>;
}

/**
 * Parses a tally value (stored as a string, or `0` / undefined when unset)
 * into a `bigint` for exact arithmetic. Totals and weights are integer key
 * counts, so `BigInt` on the raw string avoids the precision loss that
 * `Number(...)` would incur for large accumulated totals.
 */
function toBigInt(value: string | number | undefined | null): bigint {
   if (value === undefined || value === null || value === '') return 0n;
   return typeof value === 'number'
      ? BigInt(Math.round(value))
      : BigInt(value);
}

/**
 * Folds one wallet's `weight` into the proposal's current tallies.
 *
 * Pure: invoked by {@link castKeyProposalVote} inside its transaction so the
 * read-modify-write of the denormalised totals is atomic with the vote insert.
 * Key counts are integers, so `bigint` avoids floating-point drift as totals
 * accumulate and preserves every existing option bucket.
 */
export function applyVoteWeight(
   current: ProposalTotals,
   weight: string,
   option: string
): ProposalTotals {
   const w = toBigInt(weight);
   const currentResults = current.results ?? {};
   const newTotal = toBigInt(current.totalVotingWeight) + w;
   const newOptionWeight = toBigInt(currentResults[option] ?? 0) + w;

   return {
      totalVotingWeight: newTotal.toString(),
      results: {
         ...currentResults,
         [option]: newOptionWeight.toString(),
      },
   };
}

export interface CastVoteResult {
   proposalId: string;
   optionIndex: number;
   option: string;
   /** Total vote weight including delegated weight from active delegators. */
   weight: string;
   /** The voter's own key balance. */
   ownWeight: string;
   /** Sum of delegated weight from all active delegators. */
   delegatedWeight: string;
   /** Number of active delegators whose weight was included. */
   delegatorCount: number;
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
 * Vote weight = voter's own key balance + sum of key balances of all wallets
 * that have an active vote delegation pointing to this voter on the same key.
 * Revoked delegations are excluded from the weight calculation.
 *
 * The vote record is written to the `proposal_votes` table with the combined
 * weight.  A duplicate vote surfaces as a Prisma unique constraint violation
 * mapped by the route to 409.
 *
 * @returns CastVoteResult with the total weight broken down into ownWeight
 *   and delegatedWeight so callers can inspect the composition.
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

   // Own balance — determines eligibility.
   const ownership = await prisma.keyOwnership.findUnique({
      where: {
         ownerAddress_creatorId: { ownerAddress: wallet, creatorId: keyId },
      },
   });

   const ownBalance = ownership ? Number(ownership.balance) : 0;
   if (ownBalance <= 0) {
      throw new HolderNotEligibleError(wallet);
   }

   const alreadyVoted = await hasWalletVoted(keyId, proposalId, wallet);
   if (alreadyVoted) {
      throw new DuplicateVoteError();
   }

   const [delegatedBalance, delegatorCount] = await Promise.all([
      getDelegatedVoteWeight(wallet, keyId),
      prisma.voteDelegation.count({
         where: { delegateeWallet: wallet, keyId, isActive: true },
      }),
   ]);

   const totalWeight = ownBalance + delegatedBalance;
   const weightStr = String(totalWeight);
   const ownWeightStr = String(ownBalance);
   const delegatedWeightStr = String(delegatedBalance);
   const option = options[optionIndex];

   // TODO: submit cast_vote contract call via Stellar SDK
   // On-chain failure should return 502 before reaching this point.
   logger.info(
      {
         operation: 'cast_vote',
         keyId,
         proposalId,
         voter: wallet,
         optionIndex,
         option,
         ownWeight: ownWeightStr,
         delegatedWeight: delegatedWeightStr,
         totalWeight: weightStr,
         delegatorCount,
      },
      'Submitting cast_vote contract call'
   );

   // Atomically: re-read the proposal (active check + current tallies), fold
   // this wallet's weight into totalVotingWeight/results, persist the updated
   // tally, then insert the vote and its activity audit row. Using the
   // interactive transaction form ensures the tally write and the vote insert
   // commit together — they cannot diverge.
   await prisma.$transaction(async tx => {
      const proposal = await tx.governanceProposal.findUnique({
         where: { keyId_proposalId: { keyId, proposalId } },
         select: {
            totalVotingWeight: true,
            results: true,
            status: true,
         },
      });

      if (!proposal || proposal.status !== 'active') {
         const err = new Error('Proposal not found or closed');
         err.name = 'ProposalNotFoundOrClosedError';
         throw err;
      }

      const updated = applyVoteWeight(
         {
            totalVotingWeight: proposal.totalVotingWeight,
            results: proposal.results as Record<string, string>,
         },
         weightStr,
         option
      );

      await tx.governanceProposal.update({
         where: { keyId_proposalId: { keyId, proposalId } },
         data: {
            totalVotingWeight: updated.totalVotingWeight,
            results: updated.results,
         },
      });

      await tx.governanceVote.create({
         data: {
            keyId,
            proposalId,
            voter: wallet,
            optionIndex,
            weight: new Decimal(weightStr),
         },
      });

      await tx.activity.create({
         data: {
            type: 'GOVERNANCE_VOTE_CAST' as any,
            actor: wallet,
            creatorId: keyId,
            payload: {
               keyId,
               proposalId,
               optionIndex,
               option,
               ownWeight: ownWeightStr,
               delegatedWeight: delegatedWeightStr,
               totalWeight: weightStr,
               delegatorCount,
            },
         },
      });
   });

   return {
      proposalId,
      optionIndex,
      option: options[optionIndex],
      weight: weightStr,
      ownWeight: ownWeightStr,
      delegatedWeight: delegatedWeightStr,
      delegatorCount,
   };
}
