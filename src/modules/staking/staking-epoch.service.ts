// src/modules/staking/staking-epoch.service.ts
// Persistence and query logic for staking epoch data (#1086).
//
// Three concerns live here:
//   1. recordStake / removeStake        — written by the indexer from
//      StakeCreated / RewardsClaimed events.
//   2. recordEpochReward                — written by the indexer from
//      EpochRewardDistributed events.
//   3. getActivePositions / getPosition / getKeyEpochs — read by the HTTP
//      handlers; getPosition hydrates live accrued rewards from the contract.

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   getStakeRewardsLive,
   StakeRewardsFetchError,
   StakingContractNotConfiguredError,
} from './staking-epoch.contract';
import type { GetStakeRewardsDeps } from './staking-epoch.contract';

// ── Error classes ─────────────────────────────────────────────

export class StakeNotFoundError extends Error {
   constructor(stakeId: string) {
      super(`Stake not found: ${stakeId}`);
      this.name = 'StakeNotFoundError';
   }
}

// ── Indexer write helpers ─────────────────────────────────────

export interface RecordStakeInput {
   wallet: string;
   keyId: string;
   amount: string;
   startEpoch: number;
   epochsTotal?: number;
   ledger: number;
   txHash: string;
   eventIndex: number;
}

/**
 * Persists a StakeCreated event as a Stake row. The (txHash, eventIndex)
 * unique constraint makes replays a no-op.
 */
export async function recordStake(input: RecordStakeInput): Promise<void> {
   await prisma.stake.upsert({
      where: {
         txHash_eventIndex: {
            txHash: input.txHash,
            eventIndex: input.eventIndex,
         },
      },
      create: {
         wallet: input.wallet,
         keyId: input.keyId,
         amount: input.amount,
         startEpoch: input.startEpoch,
         epochsTotal: input.epochsTotal ?? null,
         ledger: input.ledger,
         txHash: input.txHash,
         eventIndex: input.eventIndex,
      },
      update: {},
   });
}

export interface RemoveStakeInput {
   txHash: string;
   eventIndex: number;
   removedAt: Date;
}

/**
 * Marks a stake as removed when a RewardsClaimed event signals the position
 * is closed. Matched by (txHash, eventIndex) of the *creating* event — the
 * caller is responsible for passing the stakeId from the claim event payload.
 * Falls back to a no-op when the stake row is not found (out-of-order replay).
 */
export async function removeStake(
   stakeId: string,
   input: RemoveStakeInput
): Promise<void> {
   const updated = await prisma.stake.updateMany({
      where: { id: stakeId, removedAt: null },
      data: { removedAt: input.removedAt },
   });

   if (updated.count === 0) {
      logger.warn(
         { stakeId, txHash: input.txHash, eventIndex: input.eventIndex },
         'removeStake: no active stake found to remove (already removed or unknown id)'
      );
   }
}

export interface RecordEpochRewardInput {
   epoch: number;
   keyId: string;
   totalDistributed: string;
   ledger: number;
   txHash: string;
   eventIndex: number;
   distributedAt: Date;
}

/**
 * Persists an EpochRewardDistributed event. Idempotent via (txHash, eventIndex).
 */
export async function recordEpochReward(
   input: RecordEpochRewardInput
): Promise<void> {
   await prisma.epochReward.upsert({
      where: {
         txHash_eventIndex: {
            txHash: input.txHash,
            eventIndex: input.eventIndex,
         },
      },
      create: {
         epoch: input.epoch,
         keyId: input.keyId,
         totalDistributed: input.totalDistributed,
         ledger: input.ledger,
         txHash: input.txHash,
         eventIndex: input.eventIndex,
         distributedAt: input.distributedAt,
      },
      update: {},
   });
}

// ── Response shapes ───────────────────────────────────────────

export interface StakePositionItem {
   id: string;
   wallet: string;
   keyId: string;
   amount: string;
   startEpoch: number;
   epochsTotal: number | null;
   /** Epochs remaining until unlock; null when no fixed duration. */
   epochsRemaining: number | null;
   /** Live accrued rewards from contract, in stroops (decimal string). */
   accruedRewards: string;
   createdAt: string;
}

export interface EpochRewardItem {
   epoch: number;
   keyId: string;
   totalDistributed: string;
   distributedAt: string;
}

// ── Accrued rewards helper ────────────────────────────────────

/**
 * Fetches live accrued rewards for a stake from the contract.
 * Returns '0' on any contract error so a single unavailable position doesn't
 * break an entire list response.
 */
async function fetchAccruedRewards(
   wallet: string,
   stakeId: string,
   deps?: GetStakeRewardsDeps
): Promise<string> {
   try {
      return await getStakeRewardsLive(wallet, stakeId, deps);
   } catch (error) {
      if (
         error instanceof StakingContractNotConfiguredError ||
         error instanceof StakeRewardsFetchError
      ) {
         logger.warn(
            { wallet, stakeId, error: (error as Error).message },
            'get_stake_rewards unavailable; returning 0 for accrued rewards'
         );
         return '0';
      }
      throw error;
   }
}

// ── Read queries ──────────────────────────────────────────────

/**
 * Returns all active (not removed) stakes for a wallet, with live accrued
 * rewards fetched in parallel from the contract.
 *
 * `currentEpoch` is supplied by the caller (from the request context or a
 * contract query); it is used only to compute `epochsRemaining` and defaults
 * to 0 when omitted.
 */
export async function getActivePositions(
   wallet: string,
   currentEpoch = 0,
   deps?: GetStakeRewardsDeps
): Promise<StakePositionItem[]> {
   const rows = await prisma.stake.findMany({
      where: { wallet, removedAt: null },
      orderBy: { createdAt: 'asc' },
   });

   if (rows.length === 0) return [];

   // Fetch live rewards for all positions in parallel.
   const rewardsResults = await Promise.allSettled(
      rows.map(r => fetchAccruedRewards(wallet, r.id, deps))
   );

   return rows.map((row, i) => {
      const rewardResult = rewardsResults[i];
      const accruedRewards =
         rewardResult.status === 'fulfilled' ? rewardResult.value : '0';

      const epochsRemaining =
         row.epochsTotal != null
            ? Math.max(0, row.startEpoch + row.epochsTotal - currentEpoch)
            : null;

      return {
         id: row.id,
         wallet: row.wallet,
         keyId: row.keyId,
         amount: row.amount.toString(),
         startEpoch: row.startEpoch,
         epochsTotal: row.epochsTotal,
         epochsRemaining,
         accruedRewards,
         createdAt: row.createdAt.toISOString(),
      };
   });
}

export interface StakePositionDetail extends StakePositionItem {
   /** Per-epoch reward history for the key this stake belongs to. */
   epochHistory: EpochRewardItem[];
}

/**
 * Returns a single active stake with live accrued rewards and the epoch
 * reward history for its key.
 *
 * Throws {@link StakeNotFoundError} when the stake doesn't exist or belongs
 * to a different wallet.
 */
export async function getPosition(
   stakeId: string,
   wallet: string,
   currentEpoch = 0,
   deps?: GetStakeRewardsDeps
): Promise<StakePositionDetail> {
   const row = await prisma.stake.findFirst({
      where: { id: stakeId, wallet, removedAt: null },
   });

   if (!row) throw new StakeNotFoundError(stakeId);

   const [accruedRewards, epochHistory] = await Promise.all([
      fetchAccruedRewards(wallet, stakeId, deps),
      prisma.epochReward.findMany({
         where: { keyId: row.keyId },
         orderBy: { epoch: 'asc' },
      }),
   ]);

   const epochsRemaining =
      row.epochsTotal != null
         ? Math.max(0, row.startEpoch + row.epochsTotal - currentEpoch)
         : null;

   return {
      id: row.id,
      wallet: row.wallet,
      keyId: row.keyId,
      amount: row.amount.toString(),
      startEpoch: row.startEpoch,
      epochsTotal: row.epochsTotal,
      epochsRemaining,
      accruedRewards,
      createdAt: row.createdAt.toISOString(),
      epochHistory: epochHistory.map(e => ({
         epoch: e.epoch,
         keyId: e.keyId,
         totalDistributed: e.totalDistributed.toString(),
         distributedAt: e.distributedAt.toISOString(),
      })),
   };
}

/**
 * Returns the epoch reward history for a key, ordered oldest-first.
 * Simple offset pagination via `limit` / `offset`.
 */
export async function getKeyEpochs(
   keyId: string,
   limit: number,
   offset: number
): Promise<{ items: EpochRewardItem[]; total: number }> {
   const [rows, total] = await Promise.all([
      prisma.epochReward.findMany({
         where: { keyId },
         orderBy: { epoch: 'asc' },
         take: limit,
         skip: offset,
      }),
      prisma.epochReward.count({ where: { keyId } }),
   ]);

   return {
      items: rows.map(r => ({
         epoch: r.epoch,
         keyId: r.keyId,
         totalDistributed: r.totalDistributed.toString(),
         distributedAt: r.distributedAt.toISOString(),
      })),
      total,
   };
}
