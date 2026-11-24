// src/modules/lp-rewards/lp-rewards.service.ts
// Key LP positions, reward view and claims (#1196).
//
// Positions are written by the LP indexer (recordKeyLpDeposit /
// recordKeyLpWithdrawal); rewards are credited by the hourly accrual job
// (lp-reward-accrual.service.ts); LPs read and claim through the API.

import { prisma } from '../../utils/prisma.utils';
import {
   formatScaled,
   minBigInt,
   parseScaled,
   parseUnits,
   percentOf,
   weightedEntryPrice,
} from './lp-reward-math';

/** The prisma client or an interactive-transaction client. */
export type KeyLpDb = Pick<typeof prisma, 'keyLpPosition'>;
type Db = KeyLpDb;

export class LpRewardsKeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'LpRewardsKeyNotFoundError';
   }
}

export class KeyLpPositionNotFoundError extends Error {
   constructor(keyId: string, wallet: string) {
      super(`No LP position for wallet ${wallet} on key ${keyId}`);
      this.name = 'KeyLpPositionNotFoundError';
   }
}

export class NothingToClaimError extends Error {
   constructor() {
      super('No claimable LP rewards');
      this.name = 'NothingToClaimError';
   }
}

/** Another claim for the same position committed first. */
export class ConcurrentClaimError extends Error {
   constructor() {
      super('A concurrent claim is already in progress for this position');
      this.name = 'ConcurrentClaimError';
   }
}

export interface KeyLpPositionView {
   keyId: string;
   wallet: string;
   /** Current LP token balance (7 dp). */
   lpTokens: string;
   /** Weighted-average entry price (7 dp). */
   entryPrice: string;
   /** Share of the key's total lp_tokens, in percent (4 dp). */
   poolSharePct: string;
   /** Balance that earns in the current epoch (7 dp). */
   eligibleLpTokens: string;
   /** Lifetime rewards credited, in base units. */
   accruedRewards: string;
   /** Lifetime rewards claimed, in base units. */
   claimedRewards: string;
   /** accruedRewards - claimedRewards, in base units. */
   claimable: string;
   lastAccruedEpochEnd: string | null;
   createdAt: string;
   updatedAt: string;
}

export interface KeyLpClaimResult {
   claimId: string;
   keyId: string;
   wallet: string;
   /** Amount transferred by this claim, in base units. */
   amount: string;
   status: string;
   accruedRewards: string;
   claimedRewards: string;
   claimable: string;
   claimedAt: string;
}

async function requireKey(keyId: string): Promise<void> {
   const key = await prisma.creatorProfile.findUnique({
      where: { id: keyId },
      select: { id: true },
   });
   if (!key) throw new LpRewardsKeyNotFoundError(keyId);
}

/**
 * Adds `lpTokens` to the (key, wallet) position, creating it if needed.
 * New tokens only become eligible at the next epoch boundary
 * (`lastDepositAt` is checked by the accrual job), and the entry price is
 * re-averaged when a deposit price is known.
 */
export async function recordKeyLpDeposit(
   db: Db,
   input: { keyId: string; wallet: string; lpTokens: string; price?: string; at?: Date }
) {
   const added = parseScaled(input.lpTokens);
   const price = input.price !== undefined ? parseScaled(input.price) : undefined;
   const at = input.at ?? new Date();

   const existing = await db.keyLpPosition.findUnique({
      where: { keyId_wallet: { keyId: input.keyId, wallet: input.wallet } },
   });

   if (!existing) {
      return db.keyLpPosition.create({
         data: {
            keyId: input.keyId,
            wallet: input.wallet,
            lpTokens: formatScaled(added),
            entryPrice: formatScaled(price ?? 0n),
            eligibleLpTokens: '0',
            lastDepositAt: at,
         },
      });
   }

   const current = parseScaled(existing.lpTokens);
   const currentEntry = parseScaled(existing.entryPrice);
   const entryPrice =
      price === undefined
         ? current === 0n
            ? 0n
            : currentEntry
         : weightedEntryPrice(current, currentEntry, added, price);

   return db.keyLpPosition.update({
      where: { id: existing.id },
      data: {
         lpTokens: formatScaled(current + added),
         entryPrice: formatScaled(entryPrice),
         lastDepositAt: at,
      },
   });
}

/**
 * Removes `lpTokens` (or the whole balance when omitted) from a position.
 * Eligibility drops immediately so withdrawn liquidity never earns.
 * Accrued, unclaimed rewards stay claimable. Returns null when the wallet
 * has no position for the key.
 */
export async function recordKeyLpWithdrawal(
   db: Db,
   input: { keyId: string; wallet: string; lpTokens?: string }
) {
   const existing = await db.keyLpPosition.findUnique({
      where: { keyId_wallet: { keyId: input.keyId, wallet: input.wallet } },
   });
   if (!existing) return null;

   const current = parseScaled(existing.lpTokens);
   const removed = input.lpTokens === undefined ? current : parseScaled(input.lpTokens);
   const next = removed >= current ? 0n : current - removed;
   const eligible = minBigInt(parseScaled(existing.eligibleLpTokens), next);

   return db.keyLpPosition.update({
      where: { id: existing.id },
      data: {
         lpTokens: formatScaled(next),
         eligibleLpTokens: formatScaled(eligible),
      },
   });
}

/** GET /keys/:keyId/lp/:wallet — position, pool share and claimable rewards. */
export async function getKeyLpPosition(keyId: string, wallet: string): Promise<KeyLpPositionView> {
   await requireKey(keyId);

   const position = await prisma.keyLpPosition.findUnique({
      where: { keyId_wallet: { keyId, wallet } },
   });
   if (!position) throw new KeyLpPositionNotFoundError(keyId, wallet);

   const totals = await prisma.keyLpPosition.aggregate({
      where: { keyId },
      _sum: { lpTokens: true },
   });

   const lpTokens = parseScaled(position.lpTokens);
   const totalLpTokens = totals._sum.lpTokens ? parseScaled(totals._sum.lpTokens) : 0n;
   const accrued = parseUnits(position.accruedRewards);
   const claimed = parseUnits(position.claimedRewards);
   const claimable = accrued > claimed ? accrued - claimed : 0n;

   return {
      keyId,
      wallet,
      lpTokens: formatScaled(lpTokens),
      entryPrice: formatScaled(parseScaled(position.entryPrice)),
      poolSharePct: percentOf(lpTokens, totalLpTokens),
      eligibleLpTokens: formatScaled(parseScaled(position.eligibleLpTokens)),
      accruedRewards: accrued.toString(),
      claimedRewards: claimed.toString(),
      claimable: claimable.toString(),
      lastAccruedEpochEnd: position.lastAccruedEpochEnd?.toISOString() ?? null,
      createdAt: position.createdAt.toISOString(),
      updatedAt: position.updatedAt.toISOString(),
   };
}

/**
 * POST /keys/:keyId/lp/:wallet/claim — transfers the full claimable balance
 * to the wallet. In one transaction: moves claimable into claimedRewards
 * (guarded by compare-and-set on the claimed balance so two concurrent
 * claims can never pay twice) and records a pending payout in
 * key_lp_reward_claims for settlement. Claimable is zero afterwards.
 */
export async function claimKeyLpRewards(keyId: string, wallet: string): Promise<KeyLpClaimResult> {
   await requireKey(keyId);

   return prisma.$transaction(async tx => {
      const position = await tx.keyLpPosition.findUnique({
         where: { keyId_wallet: { keyId, wallet } },
      });
      if (!position) throw new KeyLpPositionNotFoundError(keyId, wallet);

      const accrued = parseUnits(position.accruedRewards);
      const claimed = parseUnits(position.claimedRewards);
      const amount = accrued - claimed;
      if (amount <= 0n) throw new NothingToClaimError();

      const updated = await tx.keyLpPosition.updateMany({
         where: { id: position.id, claimedRewards: position.claimedRewards },
         data: { claimedRewards: accrued.toString() },
      });
      if (updated.count !== 1) throw new ConcurrentClaimError();

      const claim = await tx.keyLpRewardClaim.create({
         data: {
            positionId: position.id,
            keyId,
            wallet,
            amount: amount.toString(),
            status: 'pending',
         },
      });

      return {
         claimId: claim.id,
         keyId,
         wallet,
         amount: amount.toString(),
         status: claim.status,
         accruedRewards: accrued.toString(),
         claimedRewards: accrued.toString(),
         claimable: '0',
         claimedAt: claim.createdAt.toISOString(),
      };
   });
}
