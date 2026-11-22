// src/modules/lp-rewards/lp-reward-accrual.service.ts
// Hourly LP reward accrual (#1196).
//
// Epochs are fixed one-hour UTC windows [epochStart, epochEnd). For each key
// and each completed epoch, in a single transaction:
//
//   1. Fund: pool += floor(epoch trade volume * LP_FEE_BPS / 10_000). Trades
//      are windowed by `createdAt` (indexing time) so a trade indexed late is
//      funded in the epoch it was indexed in, never skipped.
//   2. Distribute: the whole pool is split across positions pro-rata by
//      eligible lp_tokens (largest-remainder, so it sums exactly). With no
//      eligible liquidity the pool carries over to the next epoch.
//   3. Roll eligibility: each position's eligible balance becomes its
//      current lp_tokens for the next epoch, unless it deposited after this
//      epoch ended. A new position therefore earns from the next epoch.
//
// Per-key cursor (key_lp_reward_pools.lastEpochEnd) plus the unique
// (keyId, epochStart) epoch row make the job idempotent and safe to run on
// several instances; missed epochs are caught up oldest first.

import type { Prisma } from '@prisma/client';
import { envConfig } from '../../config';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   allocateProRata,
   computeLpFeeAllocation,
   formatScaled,
   minBigInt,
   parseScaled,
   parseUnits,
   sumTradeVolume,
} from './lp-reward-math';

export const LP_REWARD_EPOCH_MS = 60 * 60 * 1000;

/**
 * Trades are stamped with their transaction's start time, so a trade can
 * commit shortly after the epoch it belongs to has ended. Epochs are only
 * processed once they have been closed for this long.
 */
export const LP_REWARD_SETTLE_MS = 60 * 1000;

/** Another worker advanced this key's cursor first. */
export class EpochAlreadyProcessedError extends Error {
   constructor(keyId: string, epochStart: Date) {
      super(`LP reward epoch ${epochStart.toISOString()} already processed for key ${keyId}`);
      this.name = 'EpochAlreadyProcessedError';
   }
}

export interface LpRewardEpochResult {
   keyId: string;
   epochStart: string;
   epochEnd: string;
   tradeVolume: string;
   fundedAmount: string;
   poolAmount: string;
   distributedAmount: string;
   carriedOverAmount: string;
   totalEligibleLpTokens: string;
   positionCount: number;
   allocations: Array<{ positionId: string; wallet: string; eligibleLpTokens: string; amount: string }>;
}

export interface LpRewardAccrualRunResult {
   latestEpochEnd: string;
   scannedKeys: number;
   processedEpochs: number;
   failedKeys: number;
   distributedAmount: string;
}

/** Start of the UTC hour containing `date`. */
export function epochFloor(date: Date): Date {
   return new Date(Math.floor(date.getTime() / LP_REWARD_EPOCH_MS) * LP_REWARD_EPOCH_MS);
}

/** End of the latest epoch that is closed and past the settle delay. */
export function latestSettledEpochEnd(now: Date): Date {
   return epochFloor(new Date(now.getTime() - LP_REWARD_SETTLE_MS));
}

/**
 * Processes one epoch for one key. Throws EpochAlreadyProcessedError (and
 * rolls back) when the key's cursor is not at `epochStart`.
 */
export async function processKeyLpRewardEpoch(
   keyId: string,
   epochStart: Date,
   lpFeeBps: number = envConfig.LP_FEE_BPS
): Promise<LpRewardEpochResult> {
   const epochEnd = new Date(epochStart.getTime() + LP_REWARD_EPOCH_MS);

   try {
      return await prisma.$transaction(async tx => {
         const pool = await tx.keyLpRewardPool.findUnique({ where: { keyId } });
         if (!pool || pool.lastEpochEnd.getTime() !== epochStart.getTime()) {
            throw new EpochAlreadyProcessedError(keyId, epochStart);
         }

         // 1. Fund the pool from this epoch's trading fees.
         const trades = await tx.trade.findMany({
            where: { creatorId: keyId, createdAt: { gte: epochStart, lt: epochEnd } },
            select: { price: true, quantity: true },
         });
         const { volume, skipped } = sumTradeVolume(trades);
         if (skipped > 0) {
            logger.warn(
               { keyId, epochStart: epochStart.toISOString(), skipped },
               'lp-reward-accrual: skipped trades with non-integer price/quantity'
            );
         }
         const funded = computeLpFeeAllocation(volume, lpFeeBps);
         const poolAmount = parseUnits(pool.balance) + funded;

         // 2. Distribute pro-rata by eligible lp_tokens. Capping at lpTokens
         // guards against a withdrawal racing the previous epoch's roll.
         const positions = await tx.keyLpPosition.findMany({
            where: { keyId },
            orderBy: { id: 'asc' },
         });
         const weights = positions.map(p =>
            minBigInt(parseScaled(p.eligibleLpTokens), parseScaled(p.lpTokens))
         );
         const totalEligible = weights.reduce((sum, w) => sum + w, 0n);
         const shares = allocateProRata(poolAmount, weights);
         const distributed = shares.reduce((sum, s) => sum + s, 0n);
         const carriedOver = poolAmount - distributed;
         const earning = positions.filter((_, i) => weights[i] > 0n).length;

         const epoch = await tx.keyLpRewardEpoch.create({
            data: {
               keyId,
               epochStart,
               epochEnd,
               tradeVolume: volume.toString(),
               lpFeeBps,
               fundedAmount: funded.toString(),
               poolAmount: poolAmount.toString(),
               distributedAmount: distributed.toString(),
               carriedOverAmount: carriedOver.toString(),
               totalEligibleLpTokens: formatScaled(totalEligible),
               positionCount: earning,
            },
         });

         const allocations: LpRewardEpochResult['allocations'] = [];
         const accrualRows: Prisma.KeyLpRewardAccrualCreateManyInput[] = [];
         positions.forEach((position, i) => {
            if (weights[i] === 0n) return;
            accrualRows.push({
               epochId: epoch.id,
               positionId: position.id,
               eligibleLpTokens: formatScaled(weights[i]),
               amount: shares[i].toString(),
            });
            allocations.push({
               positionId: position.id,
               wallet: position.wallet,
               eligibleLpTokens: formatScaled(weights[i]),
               amount: shares[i].toString(),
            });
         });
         if (accrualRows.length > 0) {
            await tx.keyLpRewardAccrual.createMany({ data: accrualRows });
         }

         // 3. Credit rewards and roll eligibility for the next epoch.
         for (let i = 0; i < positions.length; i += 1) {
            const position = positions[i];
            const depositedAfterEpoch =
               position.lastDepositAt !== null &&
               position.lastDepositAt.getTime() >= epochEnd.getTime();
            const nextEligible = depositedAfterEpoch
               ? weights[i]
               : parseScaled(position.lpTokens);

            await tx.keyLpPosition.update({
               where: { id: position.id },
               data: {
                  eligibleLpTokens: formatScaled(nextEligible),
                  lastAccruedEpochEnd: epochEnd,
                  ...(shares[i] > 0n
                     ? { accruedRewards: { increment: shares[i].toString() } }
                     : {}),
               },
            });
         }

         const advanced = await tx.keyLpRewardPool.updateMany({
            where: { keyId, lastEpochEnd: epochStart },
            data: {
               balance: carriedOver.toString(),
               totalFunded: { increment: funded.toString() },
               totalDistributed: { increment: distributed.toString() },
               lastEpochEnd: epochEnd,
            },
         });
         if (advanced.count !== 1) {
            throw new EpochAlreadyProcessedError(keyId, epochStart);
         }

         return {
            keyId,
            epochStart: epochStart.toISOString(),
            epochEnd: epochEnd.toISOString(),
            tradeVolume: volume.toString(),
            fundedAmount: funded.toString(),
            poolAmount: poolAmount.toString(),
            distributedAmount: distributed.toString(),
            carriedOverAmount: carriedOver.toString(),
            totalEligibleLpTokens: formatScaled(totalEligible),
            positionCount: earning,
            allocations,
         };
      });
   } catch (error) {
      // Unique (keyId, epochStart) violation: another worker won the epoch.
      if ((error as { code?: unknown } | null)?.code === 'P2002') {
         throw new EpochAlreadyProcessedError(keyId, epochStart);
      }
      throw error;
   }
}

/** Keys with LP positions, an existing pool, or trades in the latest epoch. */
async function discoverKeys(latestEpochEnd: Date): Promise<string[]> {
   const latestEpochStart = new Date(latestEpochEnd.getTime() - LP_REWARD_EPOCH_MS);
   const [positions, pools, trades] = await Promise.all([
      prisma.keyLpPosition.findMany({ distinct: ['keyId'], select: { keyId: true } }),
      prisma.keyLpRewardPool.findMany({ select: { keyId: true } }),
      prisma.trade.findMany({
         where: { createdAt: { gte: latestEpochStart, lt: latestEpochEnd } },
         distinct: ['creatorId'],
         select: { creatorId: true },
      }),
   ]);
   const keys = new Set<string>();
   positions.forEach(p => keys.add(p.keyId));
   pools.forEach(p => keys.add(p.keyId));
   trades.forEach(t => keys.add(t.creatorId));
   return [...keys].sort();
}

/**
 * Processes every pending epoch (oldest first, at most `maxEpochsPerKey`)
 * for one key. A key seen for the first time starts at the latest settled
 * epoch; earlier history is not back-funded.
 */
async function processKey(
   keyId: string,
   latestEpochEnd: Date,
   maxEpochsPerKey: number,
   lpFeeBps: number
): Promise<LpRewardEpochResult[]> {
   const pool = await prisma.keyLpRewardPool.upsert({
      where: { keyId },
      create: {
         keyId,
         lastEpochEnd: new Date(latestEpochEnd.getTime() - LP_REWARD_EPOCH_MS),
      },
      update: {},
   });

   const results: LpRewardEpochResult[] = [];
   let cursor = pool.lastEpochEnd;
   while (cursor.getTime() < latestEpochEnd.getTime() && results.length < maxEpochsPerKey) {
      try {
         results.push(await processKeyLpRewardEpoch(keyId, cursor, lpFeeBps));
      } catch (error) {
         if (error instanceof EpochAlreadyProcessedError) break;
         throw error;
      }
      cursor = new Date(cursor.getTime() + LP_REWARD_EPOCH_MS);
   }
   return results;
}

/** One run of the accrual job across all keys. */
export async function runLpRewardAccrual(
   now: Date = new Date(),
   options: { maxEpochsPerKey?: number; lpFeeBps?: number } = {}
): Promise<LpRewardAccrualRunResult> {
   const maxEpochsPerKey =
      options.maxEpochsPerKey ?? envConfig.LP_REWARD_ACCRUAL_MAX_CATCHUP_EPOCHS;
   const lpFeeBps = options.lpFeeBps ?? envConfig.LP_FEE_BPS;
   const latestEpochEnd = latestSettledEpochEnd(now);
   const keys = await discoverKeys(latestEpochEnd);

   let processedEpochs = 0;
   let failedKeys = 0;
   let distributed = 0n;

   for (const keyId of keys) {
      try {
         const results = await processKey(keyId, latestEpochEnd, maxEpochsPerKey, lpFeeBps);
         processedEpochs += results.length;
         for (const r of results) distributed += BigInt(r.distributedAmount);
      } catch (error) {
         failedKeys += 1;
         logger.error({ err: error, keyId }, 'lp-reward-accrual: key failed');
      }
   }

   const result: LpRewardAccrualRunResult = {
      latestEpochEnd: latestEpochEnd.toISOString(),
      scannedKeys: keys.length,
      processedEpochs,
      failedKeys,
      distributedAmount: distributed.toString(),
   };
   logger.info(result, 'lp-reward-accrual: completed');
   return result;
}
