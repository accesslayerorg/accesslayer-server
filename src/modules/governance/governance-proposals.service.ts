// src/modules/governance/governance-proposals.service.ts
//
// Governance proposal lifecycle with snapshot voting (#878).
//
// The server is the off-chain layer, so it cannot reconstruct historical
// staked balances at an arbitrary ledger. Instead, when a proposal is created
// the current staked balances (active StakingPosition rows for the key) are
// frozen into `governance_voting_snapshots` alongside the proposal's snapshot
// block. A vote's weight is read from that snapshot, so keys moved after
// creation cannot change how much a wallet voted with.
//
// On close the proposal transitions active -> passed | failed |
// quorum_not_met:
//   - quorum is met when cast weight >= quorumBps of the snapshot's total
//     eligible (staked) weight;
//   - with quorum met, the proposal passes when a single option holds a strict
//     majority (> 50%) of cast weight, otherwise it fails.

import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { applyVoteWeight } from '../../utils/vote-tally.utils';
import { paginateQuery } from '../../utils/pagination.utils';

export const GOVERNANCE_PROPOSALS_PAGE_SIZE = 20;

/** Default quorum: 30% of the snapshot's total eligible weight must vote. */
export const DEFAULT_QUORUM_BPS = 3000;

/** Stellar / Soroban ledgers close roughly every 5 seconds. */
export const LEDGERS_PER_DAY = 17280;

export const BPS_DENOMINATOR = 10000n;

export type ProposalStatus = 'active' | 'passed' | 'failed' | 'quorum_not_met';
export type ProposalOutcome = 'passed' | 'failed' | 'quorum_not_met';

// ── Errors ────────────────────────────────────────────────────

export class GovernanceProposalNotFoundError extends Error {
   constructor(proposalId: string) {
      super(`Governance proposal not found: ${proposalId}`);
      this.name = 'GovernanceProposalNotFoundError';
   }
}

export class VotingPeriodEndedError extends Error {
   constructor(proposalId: string) {
      super(`Voting period for proposal ${proposalId} has ended`);
      this.name = 'VotingPeriodEndedError';
   }
}

export class NoSnapshotVotingPowerError extends Error {
   constructor(wallet: string) {
      super(
         `Wallet ${wallet} had no staked balance for this key at the proposal snapshot block`
      );
      this.name = 'NoSnapshotVotingPowerError';
   }
}

export class DuplicateGovernanceVoteError extends Error {
   constructor() {
      super('Wallet has already voted on this proposal');
      this.name = 'DuplicateGovernanceVoteError';
   }
}

export class InvalidVoteOptionError extends Error {
   constructor(optionIndex: number, optionCount: number) {
      super(
         `optionIndex ${optionIndex} is out of range; proposal has ${optionCount} options`
      );
      this.name = 'InvalidVoteOptionError';
   }
}

export class GovernanceKeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'GovernanceKeyNotFoundError';
   }
}

export class WalletNotRegisteredError extends Error {
   constructor(wallet: string) {
      super(`Wallet address is not registered: ${wallet}`);
      this.name = 'WalletNotRegisteredError';
   }
}

export class NotKeyCreatorError extends Error {
   constructor() {
      super('Only the key creator can create a proposal for this key');
      this.name = 'NotKeyCreatorError';
   }
}

// ── Exact integer helpers ─────────────────────────────────────
// Staked amounts are stored as Decimal but represent whole key counts; the
// fractional part is truncated so all weight arithmetic stays on `bigint`.

function toIntegerString(value: unknown): string {
   if (value === null || value === undefined) return '0';
   const whole = String(value).split('.')[0];
   return whole === '' || whole === '-' ? '0' : whole;
}

function toBigInt(value: unknown): bigint {
   try {
      return BigInt(toIntegerString(value));
   } catch {
      return 0n;
   }
}

/** Quorum weight required: ceil(totalWeight * quorumBps / 10000). */
export function quorumRequiredWeight(
   totalWeight: string,
   quorumBps: number
): string {
   const total = toBigInt(totalWeight);
   const bps = BigInt(Math.max(0, Math.trunc(quorumBps)));
   if (total <= 0n || bps <= 0n) return '0';
   return ((total * bps + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR).toString();
}

/** Option with the greatest weight; ties resolve to the first option. */
export function leadingOption(
   options: string[],
   results: Record<string, string>
): { option: string | null; weight: string } {
   let option: string | null = null;
   let weight = 0n;
   for (const candidate of options) {
      const candidateWeight = toBigInt(results?.[candidate] ?? '0');
      if (option === null || candidateWeight > weight) {
         option = candidate;
         weight = candidateWeight;
      }
   }
   return { option, weight: weight.toString() };
}

/**
 * Pure quorum + outcome evaluation used on proposal close.
 *
 * - `quorum_not_met` when no eligible weight exists, nothing was cast, or
 *   cast weight is below the quorum threshold.
 * - `passed` when quorum is met and the leading option holds a strict majority
 *   of cast weight.
 * - `failed` otherwise.
 */
export function evaluateProposalOutcome(input: {
   options: string[];
   results: Record<string, string>;
   castWeight: string;
   snapshotTotalWeight: string;
   quorumBps: number;
}): ProposalOutcome {
   const cast = toBigInt(input.castWeight);
   const eligible = toBigInt(input.snapshotTotalWeight);

   if (eligible <= 0n || cast <= 0n) {
      return 'quorum_not_met';
   }

   const required = BigInt(
      quorumRequiredWeight(input.snapshotTotalWeight, input.quorumBps)
   );
   if (required > 0n && cast < required) {
      return 'quorum_not_met';
   }

   const { weight: leadingWeight } = leadingOption(
      input.options,
      input.results
   );
   if (BigInt(leadingWeight) * 2n > cast) {
      return 'passed';
   }
   return 'failed';
}

// ── Snapshot capture ──────────────────────────────────────────

/** Latest indexed ledger, used as the proposal's snapshot block. */
export async function getSnapshotLedger(): Promise<number> {
   const latest = await prisma.indexedLedger.findFirst({
      orderBy: { updatedAt: 'desc' },
      select: { ledger: true },
   });
   return latest?.ledger ?? 0;
}

/**
 * Staked balance per wallet for a key, as of `at`.
 *
 * Staked balance is the sum of a wallet's active `StakingPosition` amounts:
 * positions opened at or before the snapshot and not yet unlocked. Unstaked
 * holdings (`KeyOwnership`) are intentionally excluded — voting weight tracks
 * staked keys.
 */
export async function computeStakedBalancesForKey(
   keyId: string,
   at: Date
): Promise<Array<{ wallet: string; weight: string }>> {
   const rows = await prisma.stakingPosition.groupBy({
      by: ['wallet'],
      where: {
         keyId,
         amount: { gt: 0 },
         lockedAt: { lte: at },
         OR: [{ unlocksAt: null }, { unlocksAt: { gt: at } }],
      },
      _sum: { amount: true },
   });

   return rows
      .map(row => ({
         wallet: row.wallet,
         weight: toIntegerString(row._sum?.amount),
      }))
      .filter(entry => toBigInt(entry.weight) > 0n);
}

// ── DTOs ──────────────────────────────────────────────────────

export interface GovernanceProposalDto {
   id: string;
   keyId: string;
   proposalId: string;
   title: string;
   options: string[];
   status: string;
   snapshotLedger: number;
   snapshotTotalWeight: string;
   quorumBps: number;
   quorumRequired: string;
   quorumMet: boolean;
   winningOption: string | null;
   totalVotingWeight: string;
   results: Record<string, string>;
   participationRate: number | null;
   expiresAt: string;
   closedAt: string | null;
   createdAt: string;
}

interface ProposalRow {
   id: string;
   keyId: string;
   proposalId: string;
   title: string;
   options: unknown;
   results: unknown;
   totalVotingWeight: string;
   snapshotTotalWeight?: string | null;
   quorumBps?: number | null;
   snapshotLedger: number;
   expiresAt: Date;
   closedAt: Date | null;
   status: string;
   createdAt: Date;
}

function proposalToDto(proposal: ProposalRow): GovernanceProposalDto {
   const options = Array.isArray(proposal.options)
      ? (proposal.options as string[])
      : [];
   const results = (proposal.results ?? {}) as Record<string, string>;
   const snapshotTotalWeight = proposal.snapshotTotalWeight ?? '0';
   const quorumBps = proposal.quorumBps ?? DEFAULT_QUORUM_BPS;
   const cast = toBigInt(proposal.totalVotingWeight);
   const eligible = toBigInt(snapshotTotalWeight);
   const required = quorumRequiredWeight(snapshotTotalWeight, quorumBps);

   return {
      id: proposal.id,
      keyId: proposal.keyId,
      proposalId: proposal.proposalId,
      title: proposal.title,
      options,
      status: proposal.status,
      snapshotLedger: proposal.snapshotLedger,
      snapshotTotalWeight,
      quorumBps,
      quorumRequired: required,
      quorumMet: eligible > 0n && BigInt(required) <= cast,
      winningOption: leadingOption(options, results).option,
      totalVotingWeight: proposal.totalVotingWeight,
      results,
      participationRate: eligible > 0n ? Number(cast) / Number(eligible) : null,
      expiresAt: proposal.expiresAt.toISOString(),
      closedAt: proposal.closedAt ? proposal.closedAt.toISOString() : null,
      createdAt: proposal.createdAt.toISOString(),
   };
}

// ── Create ────────────────────────────────────────────────────

export interface CreateGovernanceProposalInput {
   keyId: string;
   title: string;
   options: string[];
   durationDays: number;
   quorumBps?: number;
}

export interface CreateGovernanceProposalResult {
   id: string;
   keyId: string;
   proposalId: string;
   title: string;
   options: string[];
   snapshotLedger: number;
   snapshotTotalWeight: string;
   quorumBps: number;
   totalVotingWeight: string;
   results: Record<string, string>;
   expiresAt: Date;
   status: string;
   createdAt: Date;
}

/**
 * Create a governance proposal and freeze the snapshot voting weights.
 *
 * Resolves `keyId` (creator id or handle), verifies `proposerWallet` maps to
 * the key's creator, records the current indexed ledger as the snapshot block,
 * captures every wallet's staked balance into `governance_voting_snapshots`,
 * and persists the proposal with zeroed tallies.
 */
export async function createGovernanceProposal(
   input: CreateGovernanceProposalInput,
   proposerWallet: string
): Promise<CreateGovernanceProposalResult> {
   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: input.keyId }, { handle: input.keyId }] },
      select: { id: true, userId: true },
   });

   if (!creator) {
      throw new GovernanceKeyNotFoundError(input.keyId);
   }

   const walletRecord = await prisma.stellarWallet.findUnique({
      where: { address: proposerWallet },
      select: { userId: true },
   });

   if (!walletRecord) {
      throw new WalletNotRegisteredError(proposerWallet);
   }

   if (walletRecord.userId !== creator.userId) {
      throw new NotKeyCreatorError();
   }

   const resolvedKeyId = creator.id;
   const now = new Date();
   const quorumBps = input.quorumBps ?? DEFAULT_QUORUM_BPS;
   const expiresAt = new Date(
      now.getTime() + input.durationDays * 24 * 60 * 60 * 1000
   );
   const snapshotLedger = await getSnapshotLedger();
   const proposalId = `prop-${resolvedKeyId}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 7)}`;

   const initialResults: Record<string, string> = {};
   for (const option of input.options) {
      initialResults[option] = '0';
   }

   const snapshotWeights = await computeStakedBalancesForKey(
      resolvedKeyId,
      now
   );
   const snapshotTotalWeight = snapshotWeights
      .reduce((sum, entry) => sum + toBigInt(entry.weight), 0n)
      .toString();

   // Simulated contract call: create_proposal on Soroban.
   logger.info(
      {
         operation: 'create_proposal_contract_call',
         keyId: resolvedKeyId,
         proposalId,
         snapshotLedger,
         durationDays: input.durationDays,
         durationLedgerUnits: input.durationDays * LEDGERS_PER_DAY,
         eligibleWallets: snapshotWeights.length,
         snapshotTotalWeight,
      },
      'Submitting create_proposal contract call'
   );

   const proposal = await prisma.$transaction(async tx => {
      const created = await tx.governanceProposal.create({
         data: {
            keyId: resolvedKeyId,
            proposalId,
            title: input.title,
            options: input.options,
            totalVotingWeight: '0',
            results: initialResults,
            snapshotLedger,
            snapshotTotalWeight,
            quorumBps,
            expiresAt,
            status: 'active',
         },
      });

      if (snapshotWeights.length > 0) {
         await tx.governanceVotingSnapshot.createMany({
            data: snapshotWeights.map(entry => ({
               keyId: resolvedKeyId,
               proposalId,
               wallet: entry.wallet,
               weight: new Decimal(entry.weight),
            })),
         });
      }

      return created;
   });

   await prisma.activity.create({
      data: {
         type: 'GOVERNANCE_PROPOSAL_CREATED',
         actor: proposerWallet,
         creatorId: resolvedKeyId,
         payload: {
            proposalId,
            title: input.title,
            options: input.options,
            snapshotLedger,
            snapshotTotalWeight,
            quorumBps,
            expiresAt: expiresAt.toISOString(),
         },
      },
   });

   return {
      id: proposal.id,
      keyId: resolvedKeyId,
      proposalId,
      title: input.title,
      options: input.options,
      snapshotLedger,
      snapshotTotalWeight,
      quorumBps,
      totalVotingWeight: '0',
      results: initialResults,
      expiresAt,
      status: 'active',
      createdAt: proposal.createdAt ?? now,
   };
}

// ── Vote ──────────────────────────────────────────────────────

export interface CastGovernanceVoteResult {
   keyId: string;
   proposalId: string;
   optionIndex: number;
   option: string;
   /** Snapshot weight used for this vote (staked balance at snapshot block). */
   weight: string;
   totalVotingWeight: string;
   results: Record<string, string>;
}

async function findProposal(proposalIdParam: string) {
   return prisma.governanceProposal.findFirst({
      where: {
         OR: [{ id: proposalIdParam }, { proposalId: proposalIdParam }],
      },
   });
}

export interface GovernanceVotingWeightDto {
   keyId: string;
   proposalId: string;
   wallet: string;
   weight: string;
   snapshotLedger: number;
   snapshotTotalWeight: string;
   eligible: boolean;
   hasVoted: boolean;
   proposalStatus: string;
}

export interface SnapshotTakenBalanceEntry {
   wallet: string;
   balance?: string | number;
   weight?: string | number;
}

export interface SnapshotTakenEventInput {
   keyId?: string;
   proposalId: string;
   snapshotLedger?: number;
   balances: SnapshotTakenBalanceEntry[] | Record<string, string | number>;
}

/**
 * Look up the frozen snapshot voting weight for `wallet` on a proposal (#1036).
 *
 * Reads strictly from `governance_voting_snapshots` so live balance changes
 * after the snapshot never affect the returned weight.
 */
export async function getProposalVotingWeight(
   proposalIdParam: string,
   wallet: string
): Promise<GovernanceVotingWeightDto> {
   const proposal = await findProposal(proposalIdParam);
   if (!proposal) {
      throw new GovernanceProposalNotFoundError(proposalIdParam);
   }

   const normalizedWallet = wallet.trim();
   const { keyId, proposalId } = proposal;

   const [snapshot, existingVote] = await Promise.all([
      prisma.governanceVotingSnapshot.findUnique({
         where: {
            keyId_proposalId_wallet: {
               keyId,
               proposalId,
               wallet: normalizedWallet,
            },
         },
      }),
      prisma.governanceVote.findUnique({
         where: {
            keyId_proposalId_voter: {
               keyId,
               proposalId,
               voter: normalizedWallet,
            },
         },
      }),
   ]);

   const weight = toIntegerString(snapshot?.weight);
   const eligible = toBigInt(weight) > 0n;

   return {
      keyId,
      proposalId,
      wallet: normalizedWallet,
      weight,
      snapshotLedger: proposal.snapshotLedger,
      snapshotTotalWeight: proposal.snapshotTotalWeight ?? '0',
      eligible,
      hasVoted: Boolean(existingVote),
      proposalStatus: proposal.status,
   };
}

/**
 * Pre-validate a vote submission against the proposal's frozen snapshot (#1036).
 *
 * Ensures the proposal exists, is active and within its voting deadline, the
 * option index is valid, the wallet has not already voted, and returns the
 * frozen snapshot voting weight (> 0) for the wallet.
 */
export async function validateVoteSubmissionWeight(
   proposalIdParam: string,
   wallet: string,
   optionIndex?: number,
   now: Date = new Date()
) {
   const proposal = await findProposal(proposalIdParam);
   if (!proposal) {
      throw new GovernanceProposalNotFoundError(proposalIdParam);
   }

   const { keyId, proposalId } = proposal;

   if (proposal.status !== 'active' || now >= proposal.expiresAt) {
      throw new VotingPeriodEndedError(proposalId);
   }

   const options = Array.isArray(proposal.options)
      ? (proposal.options as string[])
      : [];
   if (
      optionIndex !== undefined &&
      (optionIndex < 0 || optionIndex >= options.length)
   ) {
      throw new InvalidVoteOptionError(optionIndex, options.length);
   }

   const snapshot = await prisma.governanceVotingSnapshot.findUnique({
      where: {
         keyId_proposalId_wallet: { keyId, proposalId, wallet },
      },
   });

   const weight = toIntegerString(snapshot?.weight);
   if (toBigInt(weight) <= 0n) {
      throw new NoSnapshotVotingPowerError(wallet);
   }

   const existing = await prisma.governanceVote.findUnique({
      where: {
         keyId_proposalId_voter: { keyId, proposalId, voter: wallet },
      },
   });
   if (existing) {
      throw new DuplicateGovernanceVoteError();
   }

   return {
      proposal,
      keyId,
      proposalId,
      options,
      weight,
   };
}

/**
 * Prunes stored `GovernanceVotingSnapshot` rows for a resolved proposal (#1036).
 */
export async function pruneProposalSnapshots(
   keyId: string,
   proposalId: string
): Promise<number> {
   if (!prisma.governanceVotingSnapshot?.deleteMany) {
      return 0;
   }
   const deleted = await prisma.governanceVotingSnapshot.deleteMany({
      where: { keyId, proposalId },
   });
   return deleted?.count ?? 0;
}

/**
 * Indexes a `SnapshotTaken` contract event (#1036), storing per-wallet snapshot
 * balances for the proposal and updating the proposal's `snapshotTotalWeight`
 * (and `snapshotLedger` when provided). Idempotent across replays.
 */
export async function recordProposalSnapshot(
   input: SnapshotTakenEventInput
): Promise<{
   keyId: string;
   proposalId: string;
   walletsIndexed: number;
   snapshotTotalWeight: string;
}> {
   const proposal = input.keyId
      ? await prisma.governanceProposal.findUnique({
           where: {
              keyId_proposalId: {
                 keyId: input.keyId,
                 proposalId: input.proposalId,
              },
           },
        })
      : await findProposal(input.proposalId);

   const resolvedKeyId = proposal?.keyId ?? input.keyId;
   if (!resolvedKeyId) {
      throw new GovernanceProposalNotFoundError(input.proposalId);
   }
   const resolvedProposalId = proposal?.proposalId ?? input.proposalId;

   const rawEntries: Array<{ wallet: string; weight: string }> = Array.isArray(
      input.balances
   )
      ? input.balances.map(entry => ({
           wallet: String(entry.wallet ?? '').trim(),
           weight: toIntegerString(entry.weight ?? entry.balance),
        }))
      : Object.entries(input.balances ?? {}).map(([wallet, bal]) => ({
           wallet: wallet.trim(),
           weight: toIntegerString(bal),
        }));

   // Deduplicate by wallet (last entry wins) and filter positive weights
   const deduped = new Map<string, string>();
   for (const entry of rawEntries) {
      if (!entry.wallet) continue;
      if (toBigInt(entry.weight) > 0n) {
         deduped.set(entry.wallet, entry.weight);
      } else {
         deduped.delete(entry.wallet);
      }
   }

   const validEntries = Array.from(deduped.entries()).map(
      ([wallet, weight]) => ({ wallet, weight })
   );
   const snapshotTotalWeight = validEntries
      .reduce((sum, entry) => sum + toBigInt(entry.weight), 0n)
      .toString();

   await prisma.$transaction(async tx => {
      if (tx.governanceVotingSnapshot?.deleteMany) {
         await tx.governanceVotingSnapshot.deleteMany({
            where: { keyId: resolvedKeyId, proposalId: resolvedProposalId },
         });
      }

      if (validEntries.length > 0) {
         await tx.governanceVotingSnapshot.createMany({
            data: validEntries.map(entry => ({
               keyId: resolvedKeyId,
               proposalId: resolvedProposalId,
               wallet: entry.wallet,
               weight: new Decimal(entry.weight),
            })),
         });
      }

      if (proposal) {
         await tx.governanceProposal.update({
            where: {
               keyId_proposalId: {
                  keyId: resolvedKeyId,
                  proposalId: resolvedProposalId,
               },
            },
            data: {
               snapshotTotalWeight,
               ...(typeof input.snapshotLedger === 'number'
                  ? { snapshotLedger: input.snapshotLedger }
                  : {}),
            },
         });
      }
   });

   return {
      keyId: resolvedKeyId,
      proposalId: resolvedProposalId,
      walletsIndexed: validEntries.length,
      snapshotTotalWeight,
   };
}

/**
 * Cast a governance vote weighted by the wallet's snapshot staked balance.
 *
 * @throws {GovernanceProposalNotFoundError} 404 — no such proposal
 * @throws {VotingPeriodEndedError} 409 — proposal closed or past its deadline
 * @throws {InvalidVoteOptionError} 422 — optionIndex out of range
 * @throws {NoSnapshotVotingPowerError} 403 — wallet had no weight at snapshot
 * @throws {DuplicateGovernanceVoteError} 409 — wallet already voted
 */
export async function castGovernanceVote(
   proposalIdParam: string,
   wallet: string,
   optionIndex: number
): Promise<CastGovernanceVoteResult> {
   const { keyId, proposalId, options, weight } =
      await validateVoteSubmissionWeight(proposalIdParam, wallet, optionIndex);

   const option = options[optionIndex];

   try {
      const updated = await prisma.$transaction(async tx => {
         const current = await tx.governanceProposal.findUnique({
            where: { keyId_proposalId: { keyId, proposalId } },
            select: {
               status: true,
               expiresAt: true,
               totalVotingWeight: true,
               results: true,
            },
         });

         if (
            !current ||
            current.status !== 'active' ||
            new Date() >= current.expiresAt
         ) {
            throw new VotingPeriodEndedError(proposalId);
         }

         const tallies = applyVoteWeight(
            {
               totalVotingWeight: current.totalVotingWeight,
               results: (current.results ?? {}) as Record<string, string>,
            },
            weight,
            option
         );

         await tx.governanceProposal.update({
            where: { keyId_proposalId: { keyId, proposalId } },
            data: {
               totalVotingWeight: tallies.totalVotingWeight,
               results: tallies.results,
            },
         });

         await tx.governanceVote.create({
            data: {
               keyId,
               proposalId,
               voter: wallet,
               optionIndex,
               weight: new Decimal(weight),
            },
         });

         return tallies;
      });

      logger.info(
         {
            operation: 'cast_vote',
            keyId,
            proposalId,
            voter: wallet,
            optionIndex,
            option,
            weight,
         },
         'Submitting cast_vote contract call'
      );

      await prisma.activity.create({
         data: {
            type: 'GOVERNANCE_VOTE_CAST',
            actor: wallet,
            creatorId: keyId,
            payload: {
               keyId,
               proposalId,
               optionIndex,
               option,
               weight,
            },
         },
      });

      return {
         keyId,
         proposalId,
         optionIndex,
         option,
         weight,
         totalVotingWeight: updated.totalVotingWeight,
         results: updated.results,
      };
   } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') {
         throw new DuplicateGovernanceVoteError();
      }
      throw error;
   }
}

// ── Close / quorum ────────────────────────────────────────────

export interface CloseDueProposalsResult {
   scanned: number;
   closed: number;
   prunedSnapshots?: number;
   outcomes: Record<ProposalOutcome, number>;
}

/**
 * Close every active proposal whose deadline has passed, computing the quorum
 * outcome, transitioning its status, and pruning its snapshot rows (#878, #1036).
 * Idempotent — already-closed proposals are never revisited.
 */
export async function closeDueProposals(
   now: Date = new Date()
): Promise<CloseDueProposalsResult> {
   const due = await prisma.governanceProposal.findMany({
      where: { status: 'active', expiresAt: { lte: now } },
   });

   const outcomes: Record<ProposalOutcome, number> = {
      passed: 0,
      failed: 0,
      quorum_not_met: 0,
   };
   let prunedSnapshots = 0;

   for (const proposal of due) {
      const outcome = evaluateProposalOutcome({
         options: Array.isArray(proposal.options)
            ? (proposal.options as string[])
            : [],
         results: (proposal.results ?? {}) as Record<string, string>,
         castWeight: proposal.totalVotingWeight,
         snapshotTotalWeight: proposal.snapshotTotalWeight ?? '0',
         quorumBps: proposal.quorumBps ?? DEFAULT_QUORUM_BPS,
      });

      await prisma.governanceProposal.update({
         where: { id: proposal.id },
         data: { status: outcome, closedAt: now },
      });
      prunedSnapshots += await pruneProposalSnapshots(
         proposal.keyId,
         proposal.proposalId
      );
      outcomes[outcome] += 1;
   }

   return {
      scanned: due.length,
      closed: due.length,
      prunedSnapshots,
      outcomes,
   };
}

// ── List ──────────────────────────────────────────────────────

export interface ListGovernanceProposalsOptions {
   status?: ProposalStatus;
   keyId?: string;
   cursor?: string;
}

export interface ListGovernanceProposalsResult {
   items: GovernanceProposalDto[];
   next_cursor: string | null;
   has_more: boolean;
}

/**
 * List proposals with vote tallies and status. Expired proposals are closed
 * (quorum computed) before the listing so clients never see a stale `active`
 * status that should already be terminal.
 */
export async function listGovernanceProposals(
   options: ListGovernanceProposalsOptions = {}
): Promise<ListGovernanceProposalsResult> {
   await closeDueProposals();

   const where: Record<string, unknown> = {};
   if (options.status) where.status = options.status;
   if (options.keyId) where.keyId = options.keyId;

   const { data, nextCursor, hasMore } = await paginateQuery(
      args =>
         prisma.governanceProposal.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            ...args,
         }),
      {
         cursor: options.cursor ? { id: options.cursor } : undefined,
         limit: GOVERNANCE_PROPOSALS_PAGE_SIZE,
      }
   );

   return {
      items: data.map(proposalToDto),
      next_cursor: hasMore ? (nextCursor ?? null) : null,
      has_more: hasMore,
   };
}

export { proposalToDto };

