// src/modules/revenue/revenue.service.ts
// Protocol revenue distribution with the claim-based dividend model (#883).
//
// Trading fees are aggregated into a pool per distribution cycle (cycle
// length configurable via REVENUE_DISTRIBUTION_CYCLE_DAYS). Once a cycle
// ends it is finalized (snapshotting the pool for the audit trail) and each
// staker's claimable share is computed proportionally to their stake weight
// — the sum of their key balances across the protocol.
//
// POST /revenue/claim processes only unclaimed amounts; a unique
// (cycleId, wallet) constraint rejects double-claims within the same cycle
// with 409. GET /revenue/claimable returns the accurate unclaimed balance.

import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { envConfig } from '../../config';
import { emitAuditEvent } from '../../utils/audit.utils';
import { createAuditEntry } from '../admin/audit-log.service';

/** Protocol epoch all cycle indexes are measured from (UTC). */
export const REVENUE_CYCLE_EPOCH_MS = Date.UTC(2026, 0, 1);

export class NothingToClaimError extends Error {
   constructor(message = 'No claimable revenue for this cycle') {
      super(message);
      this.name = 'NothingToClaimError';
   }
}

export class AlreadyClaimedError extends Error {
   constructor(cycleIndex: number, wallet: string) {
      super(`Wallet ${wallet} already claimed revenue for cycle ${cycleIndex}`);
      this.name = 'AlreadyClaimedError';
   }
}

export interface RevenueCycleWindow {
   cycleIndex: number;
   startsAt: Date;
   endsAt: Date;
}

export function getCycleDurationMs(): number {
   return envConfig.REVENUE_DISTRIBUTION_CYCLE_DAYS * 24 * 60 * 60 * 1000;
}

export function getCycleWindow(cycleIndex: number): RevenueCycleWindow {
   const duration = getCycleDurationMs();
   return {
      cycleIndex,
      startsAt: new Date(REVENUE_CYCLE_EPOCH_MS + cycleIndex * duration),
      endsAt: new Date(REVENUE_CYCLE_EPOCH_MS + (cycleIndex + 1) * duration),
   };
}

export function getCurrentCycleIndex(now: Date = new Date()): number {
   return Math.floor((now.getTime() - REVENUE_CYCLE_EPOCH_MS) / getCycleDurationMs());
}

/** The most recent cycle that has fully ended, or null if none has yet. */
export function getLatestEndedCycle(
   now: Date = new Date()
): RevenueCycleWindow | null {
   const current = getCurrentCycleIndex(now);
   if (current < 1) return null;
   return getCycleWindow(current - 1);
}

/**
 * Aggregate protocol trading fees accrued inside a cycle window into the
 * pool amount: sum(price * quantity * protocolFeeBps / 10000) over trades
 * with a timestamp in [startsAt, endsAt).
 */
async function computeCycleFeesXlm(
   window: RevenueCycleWindow
): Promise<number> {
   const config = await prisma.protocolConfig.upsert({
      where: { id: 'default' },
      create: { id: 'default', protocolFeeBps: 500 },
      update: {},
      select: { protocolFeeBps: true },
   });

   const trades = await prisma.trade.findMany({
      where: {
         timestamp: { gte: window.startsAt, lt: window.endsAt },
      },
      select: { price: true, quantity: true },
   });

   let totalFeesXlm = 0;
   for (const trade of trades) {
      const value = Number(trade.price) * Number(trade.quantity);
      totalFeesXlm += (value * config.protocolFeeBps) / 10000;
   }
   return totalFeesXlm;
}

/**
 * Finalize (snapshot) an ended cycle: creates the RevenueCycle record with
 * the aggregated fee pool on first call and returns it on subsequent calls.
 * These records are the distribution cycle audit trail.
 */
export async function finalizeCycle(
   window: RevenueCycleWindow
): Promise<{
   id: string;
   cycleIndex: number;
   startsAt: Date;
   endsAt: Date;
   totalFeesXlm: number;
   distributedXlm: number;
}> {
   const existing = await prisma.revenueCycle.findUnique({
      where: { cycleIndex: window.cycleIndex },
   });
   if (existing) {
      return {
         ...existing,
         totalFeesXlm: Number(existing.totalFeesXlm),
         distributedXlm: Number(existing.distributedXlm),
      };
   }

   const totalFeesXlm = await computeCycleFeesXlm(window);
   try {
      const created = await prisma.revenueCycle.create({
         data: {
            cycleIndex: window.cycleIndex,
            startsAt: window.startsAt,
            endsAt: window.endsAt,
            totalFeesXlm,
         },
      });
      logger.info(
         {
            cycleIndex: window.cycleIndex,
            totalFeesXlm,
            startsAt: window.startsAt.toISOString(),
            endsAt: window.endsAt.toISOString(),
         },
         'Revenue distribution cycle finalized'
      );
      return {
         ...created,
         totalFeesXlm: Number(created.totalFeesXlm),
         distributedXlm: Number(created.distributedXlm),
      };
   } catch (error) {
      // Concurrent finalization: another request created the cycle first.
      if (
         error instanceof Prisma.PrismaClientKnownRequestError &&
         error.code === 'P2002'
      ) {
         const row = await prisma.revenueCycle.findUnique({
            where: { cycleIndex: window.cycleIndex },
         });
         if (row) {
            return {
               ...row,
               totalFeesXlm: Number(row.totalFeesXlm),
               distributedXlm: Number(row.distributedXlm),
            };
         }
      }
      throw error;
   }
}

interface StakeWeights {
   totalStake: number;
   byWallet: Map<string, number>;
}

/**
 * Stake weight per wallet: aggregate key balance across all positions.
 * Each staker's claimable share is proportional to this weight.
 */
async function getStakeWeights(): Promise<StakeWeights> {
   const grouped = await prisma.keyOwnership.groupBy({
      by: ['ownerAddress'],
      where: { balance: { gt: 0 } },
      _sum: { balance: true },
   });

   const byWallet = new Map<string, number>();
   let totalStake = 0;
   for (const row of grouped) {
      const weight = Number(row._sum.balance ?? 0);
      if (weight <= 0) continue;
      byWallet.set(row.ownerAddress, weight);
      totalStake += weight;
   }
   return { totalStake, byWallet };
}

async function computeEntitledAmountXlm(
   cycle: { totalFeesXlm: number },
   wallet: string
): Promise<number> {
   if (cycle.totalFeesXlm <= 0) return 0;
   const { totalStake, byWallet } = await getStakeWeights();
   if (totalStake <= 0) return 0;
   const walletStake = byWallet.get(wallet) ?? 0;
   if (walletStake <= 0) return 0;
   return (cycle.totalFeesXlm * walletStake) / totalStake;
}

export interface ClaimableRevenueResult {
   wallet: string;
   claimableXlm: string;
   claimed: boolean;
   cycle: {
      cycleIndex: number;
      startsAt: string;
      endsAt: string;
      totalFeesXlm: string;
   } | null;
}

function cycleView(cycle: {
   cycleIndex: number;
   startsAt: Date;
   endsAt: Date;
   totalFeesXlm: number;
}) {
   return {
      cycleIndex: cycle.cycleIndex,
      startsAt: cycle.startsAt.toISOString(),
      endsAt: cycle.endsAt.toISOString(),
      totalFeesXlm: cycle.totalFeesXlm.toString(),
   };
}

/**
 * Accurate unclaimed revenue balance for a wallet: finalizes the latest
 * ended cycle and returns the wallet's proportional share when unclaimed.
 */
export async function getClaimableRevenue(
   wallet: string,
   now: Date = new Date()
): Promise<ClaimableRevenueResult> {
   const window = getLatestEndedCycle(now);
   if (!window) {
      return { wallet, claimableXlm: '0', claimed: false, cycle: null };
   }

   const cycle = await finalizeCycle(window);
   const existing = await prisma.revenueClaim.findUnique({
      where: { cycleId_wallet: { cycleId: cycle.id, wallet } },
   });
   if (existing?.claimedAt) {
      return {
         wallet,
         claimableXlm: '0',
         claimed: true,
         cycle: cycleView(cycle),
      };
   }

   const entitled = await computeEntitledAmountXlm(cycle, wallet);
   return {
      wallet,
      claimableXlm: entitled.toFixed(7),
      claimed: false,
      cycle: cycleView(cycle),
   };
}

export interface ClaimRevenueResult {
   claimId: string;
   wallet: string;
   cycleIndex: number;
   amountXlm: string;
   claimedAt: Date;
}

/**
 * Claim the wallet's unclaimed share of the latest ended cycle. Only the
 * unclaimed amount is processed; a unique (cycleId, wallet) row makes the
 * double-claim race-safe (P2002 → AlreadyClaimedError → 409).
 */
export async function claimRevenue(
   wallet: string,
   now: Date = new Date()
): Promise<ClaimRevenueResult> {
   const window = getLatestEndedCycle(now);
   if (!window) {
      throw new NothingToClaimError(
         'No completed distribution cycle is available to claim yet'
      );
   }

   const cycle = await finalizeCycle(window);
   const entitled = await computeEntitledAmountXlm(cycle, wallet);
   if (entitled <= 0) {
      throw new NothingToClaimError();
   }

   try {
      const claimedAt = new Date();
      const claim = await prisma.$transaction(async tx => {
         const created = await tx.revenueClaim.create({
            data: {
               cycleId: cycle.id,
               wallet,
               entitledAmountXlm: entitled,
               claimedAt,
            },
         });
         await tx.revenueCycle.update({
            where: { id: cycle.id },
            data: { distributedXlm: { increment: entitled } },
         });
         return created;
      });

      const metadata = {
         claimId: claim.id,
         cycleIndex: cycle.cycleIndex,
         wallet,
         amountXlm: entitled,
      };
      await emitAuditEvent({
         actor: wallet,
         action: 'revenue_claimed',
         target: 'RevenueCycle',
         targetId: cycle.id,
         metadata,
      });
      await createAuditEntry({
         actorWallet: wallet,
         actionType: 'revenue_claimed',
         targetId: cycle.id,
         payload: metadata,
      });

      logger.info(metadata, 'Protocol revenue claim processed');

      return {
         claimId: claim.id,
         wallet,
         cycleIndex: cycle.cycleIndex,
         amountXlm: entitled.toFixed(7),
         claimedAt,
      };
   } catch (error) {
      if (
         error instanceof Prisma.PrismaClientKnownRequestError &&
         error.code === 'P2002'
      ) {
         throw new AlreadyClaimedError(cycle.cycleIndex, wallet);
      }
      throw error;
   }
}
