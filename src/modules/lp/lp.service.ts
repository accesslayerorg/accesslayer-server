// src/modules/lp/lp.service.ts
//
// LP position and rewards API (#980).

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { buildLogFields } from '../../utils/log-fields.utils';
import * as lpRewardsContract from './lp-rewards.contract';

export class LpPositionNotFoundError extends Error {
   constructor(lpId: string) {
      super(`LP position not found: ${lpId}`);
      this.name = 'LpPositionNotFoundError';
   }
}

export interface LpPositionSummary {
   lpId: string;
   wallet: string;
   keyId: string;
   amount: string;
   sharePercent: string;
   accruedRewards: string;
   status: string;
   rewardsSource?: 'live' | 'stored';
   createdAt: string;
   updatedAt: string;
}

function toSummary(position: {
   lpId: string;
   wallet: string;
   keyId: string;
   amount: unknown;
   sharePercent: unknown;
   accruedRewards: unknown;
   status: string;
   createdAt: Date | string;
   updatedAt: Date | string;
}): LpPositionSummary {
   return {
      lpId: position.lpId,
      wallet: position.wallet,
      keyId: position.keyId,
      amount: String(position.amount),
      sharePercent: String(position.sharePercent),
      accruedRewards: String(position.accruedRewards),
      status: position.status,
      createdAt:
         position.createdAt instanceof Date
            ? position.createdAt.toISOString()
            : new Date(position.createdAt).toISOString(),
      updatedAt:
         position.updatedAt instanceof Date
            ? position.updatedAt.toISOString()
            : new Date(position.updatedAt).toISOString(),
   };
}

async function attachLiveRewards(
   summary: LpPositionSummary
): Promise<LpPositionSummary> {
   try {
      const liveRewards = await lpRewardsContract.getLpRewardsLive(
         summary.wallet,
         summary.keyId
      );
      return {
         ...summary,
         accruedRewards: liveRewards,
         rewardsSource: 'live',
      };
   } catch (error) {
      if (
         error instanceof lpRewardsContract.LpContractNotConfiguredError ||
         error instanceof lpRewardsContract.LpRewardsFetchError
      ) {
         logger.warn(
            buildLogFields({
               type: 'lp_live_rewards_fallback',
               lpId: summary.lpId,
               wallet: summary.wallet,
               keyId: summary.keyId,
               error: error instanceof Error ? error.message : String(error),
            }),
            'Failed to fetch live LP rewards; falling back to stored rewards'
         );
         return {
            ...summary,
            rewardsSource: 'stored',
         };
      }
      throw error;
   }
}

/** All active LP positions for a wallet. */
export async function getLpPositionsByWallet(
   wallet: string
): Promise<LpPositionSummary[]> {
   const positions = await prisma.lpPosition.findMany({
      where: { wallet, status: 'active' },
      orderBy: { createdAt: 'desc' },
   });
   return positions.map(toSummary);
}

/**
 * All active LP positions for a wallet with live rewards fetched from
 * the LP rewards contract. Concurrency is limited to 5 calls at a time.
 */
export async function getLpPositionsWithLiveRewards(
   wallet: string
): Promise<LpPositionSummary[]> {
   const positions = await prisma.lpPosition.findMany({
      where: { wallet, status: 'active' },
      orderBy: { createdAt: 'desc' },
   });
   const summaries = positions.map(toSummary);

   const CHUNK_SIZE = 5;
   const results: LpPositionSummary[] = [];
   for (let i = 0; i < summaries.length; i += CHUNK_SIZE) {
      const chunk = summaries.slice(i, i + CHUNK_SIZE);
      const enrichedChunk = await Promise.all(
         chunk.map((summary) => attachLiveRewards(summary))
      );
      results.push(...enrichedChunk);
   }
   return results;
}

/**
 * Single LP position by lpId, scoped to the owning wallet. Throws
 * LpPositionNotFoundError both when the position doesn't exist and when it
 * exists but isn't owned by `wallet`, so ownership is never leaked via a
 * distinct error type/status.
 */
export async function getLpPositionById(
   lpId: string,
   wallet: string
): Promise<LpPositionSummary> {
   const position = await prisma.lpPosition.findUnique({ where: { lpId } });
   if (!position || position.wallet !== wallet) {
      throw new LpPositionNotFoundError(lpId);
   }
   return toSummary(position);
}

/**
 * Single LP position detail scoped to the owning wallet. If the position is
 * active, live rewards are fetched; if removed, stored rewards are returned
 * with no contract call. Throws LpPositionNotFoundError if not found or not owned.
 */
export async function getLpPositionDetailWithLiveRewards(
   positionId: string,
   wallet: string
): Promise<LpPositionSummary> {
   const position = await prisma.lpPosition.findUnique({
      where: { lpId: positionId },
   });
   if (!position || position.wallet !== wallet) {
      throw new LpPositionNotFoundError(positionId);
   }

   const summary = toSummary(position);
   if (summary.status === 'active') {
      return attachLiveRewards(summary);
   }

   return {
      ...summary,
      rewardsSource: 'stored',
   };
}

export interface LpPoolSummary {
   keyId: string;
   totalPoolSize: string;
   /**
    * Simplified APR estimate: recent accrued rewards across the pool,
    * annualized against pool size. This is NOT a precise on-chain yield
    * figure — it ignores compounding, time-weighting of individual
    * positions, and reward-rate changes over time. Treat as a rough
    * indicator only.
    */
   estimatedApr: number;
}

/** Total active pool size and a simplified APR estimate for a key. */
export async function getLpPoolSummary(keyId: string): Promise<LpPoolSummary> {
   const positions = await prisma.lpPosition.findMany({
      where: { keyId, status: 'active' },
   });

   const totalPoolSize = positions.reduce(
      (sum, p) => sum + Number(p.sharePercent),
      0
   );
   const totalRewards = positions.reduce(
      (sum, p) => sum + Number(p.accruedRewards),
      0
   );

   // Simplified placeholder: annualize accrued-to-date rewards against pool
   // size as if the current accrual rate held for a full year. Real APR
   // would need a time-windowed reward rate, not lifetime accrued rewards.
   const estimatedApr =
      totalPoolSize > 0 ? (totalRewards / totalPoolSize) * 100 : 0;

   return {
      keyId,
      totalPoolSize: String(totalPoolSize),
      estimatedApr,
   };
}
