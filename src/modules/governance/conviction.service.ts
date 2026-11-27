// src/modules/governance/conviction.service.ts
// Conviction voting progress replay & rage-quit eligibility service (#1306).

import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheInvalidate,
   cacheSetJson,
} from '../../utils/redis.utils';

export const CONVICTION_CACHE_TTL_SECONDS = 10;
export const DEFAULT_DECAY_ALPHA_BPS = 9000n; // 0.90 per ledger
export const BPS_SCALE = 10_000n;
export const DEFAULT_RAGEQUIT_CAP_BPS = 2000n; // 20% of total staked/supply
export const DEFAULT_RAGEQUIT_WINDOW_LEDGERS = 17_280; // ~24h at 5s/ledger
const MAX_PROJECTION_LEDGERS = 50_000;

export interface ConvictionProgressResult {
   proposalId: string;
   conviction: string;
   threshold: string;
   totalStaked: string;
   currentLedger: number;
   projectedCrossingLedger: number | null;
   executed: boolean;
   walletStake?: {
      wallet: string;
      amount: string;
      isActive: boolean;
      stakedAtLedger: number;
   } | null;
}

export interface RagequitStatusResult {
   proposalId: string;
   windowOpen: boolean;
   windowStartLedger: number | null;
   windowEndLedger: number | null;
   totalExits: string;
   exitCap: string;
   remainingCap: string;
   eligible: boolean | null;
   eligibilityReason: string | null;
}

export class ConvictionProposalNotFoundError extends Error {
   constructor(proposalId: string) {
      super(`Conviction proposal not found: ${proposalId}`);
      this.name = 'ConvictionProposalNotFoundError';
   }
}

function progressCacheKey(proposalId: string, wallet?: string): string {
   return `conviction:progress:${proposalId}:${wallet ?? 'all'}`;
}

function ragequitCacheKey(proposalId: string, wallet?: string): string {
   return `conviction:ragequit:${proposalId}:${wallet ?? 'all'}`;
}

/**
 * Replays discrete conviction decay identical to the contract:
 *   C_{t+1} = floor(C_t * alphaBps / 10_000) + totalStaked
 */
export function stepConviction(
   initialConviction: bigint,
   totalStaked: bigint,
   deltaLedgers: number,
   alphaBps: bigint = DEFAULT_DECAY_ALPHA_BPS
): bigint {
   if (deltaLedgers <= 0) return initialConviction;
   let c = initialConviction;
   for (let i = 0; i < deltaLedgers; i++) {
      c = (c * alphaBps) / BPS_SCALE + totalStaked;
   }
   return c;
}

/**
 * Projects the earliest ledger >= `currentLedger` at which conviction reaches
 * `threshold` assuming `totalStaked` remains constant. Returns `null` if the
 * steady-state maximum `totalStaked / (1 - alpha)` is below `threshold`.
 */
export function projectCrossingLedger(
   currentConviction: bigint,
   totalStaked: bigint,
   threshold: bigint,
   currentLedger: number,
   alphaBps: bigint = DEFAULT_DECAY_ALPHA_BPS
): number | null {
   if (threshold <= 0n || currentConviction >= threshold) {
      return currentLedger;
   }
   if (totalStaked <= 0n) {
      return null;
   }

   const oneMinusAlpha = BPS_SCALE - alphaBps;
   if (oneMinusAlpha > 0n) {
      const steadyStateMax = (totalStaked * BPS_SCALE) / oneMinusAlpha;
      if (steadyStateMax < threshold) {
         return null;
      }
   }

   let c = currentConviction;
   for (let step = 1; step <= MAX_PROJECTION_LEDGERS; step++) {
      c = (c * alphaBps) / BPS_SCALE + totalStaked;
      if (c >= threshold) {
         return currentLedger + step;
      }
   }
   return null;
}

export class ConvictionService {
   private readonly alphaBps: bigint;

   constructor(options?: { alphaBps?: bigint }) {
      this.alphaBps = options?.alphaBps ?? DEFAULT_DECAY_ALPHA_BPS;
   }

   async invalidateProposalCache(proposalId: string): Promise<void> {
      await Promise.all([
         cacheInvalidate(`conviction:progress:${proposalId}:*`),
         cacheInvalidate(`conviction:ragequit:${proposalId}:*`),
      ]);
   }

   async progress(
      proposalId: string,
      options?: { wallet?: string; currentLedger?: number }
   ): Promise<ConvictionProgressResult> {
      const wallet = options?.wallet;
      const cacheKey = progressCacheKey(proposalId, wallet);

      if (options?.currentLedger === undefined) {
         const cached = await cacheGetJson<ConvictionProgressResult>(cacheKey);
         if (cached !== null) return cached;
      }

      const snapshots = await prisma.convictionSnapshot.findMany({
         where: { proposalId },
         orderBy: [{ ledger: 'asc' }, { eventIndex: 'asc' }],
      });

      const activeStakes = await prisma.convictionStake.findMany({
         where: { proposalId, isActive: true },
      });

      const proposal = await prisma.governanceProposal.findFirst({
         where: { OR: [{ id: proposalId }, { proposalId }] },
         select: {
            proposalId: true,
            snapshotLedger: true,
            snapshotTotalWeight: true,
            executedAt: true,
            status: true,
         },
      });

      if (snapshots.length === 0 && activeStakes.length === 0 && !proposal) {
         throw new ConvictionProposalNotFoundError(proposalId);
      }

      const latestLedgerRow = await prisma.ledgerCheckpoint.findFirst({
         orderBy: { ledger: 'desc' },
         select: { ledger: true },
      });

      const lastSnapshot = snapshots[snapshots.length - 1];
      const currentLedger =
         options?.currentLedger ??
         Math.max(
            latestLedgerRow?.ledger ?? 0,
            lastSnapshot?.ledger ?? proposal?.snapshotLedger ?? 0
         );

      // Replay decay from snapshots
      let conviction = 0n;
      let totalStaked = 0n;
      let threshold = lastSnapshot?.threshold ?? 0n;
      let lastLedger = snapshots[0]?.ledger ?? currentLedger;
      let executed = snapshots.some(s => s.executed) || proposal?.status === 'executed';

      for (const snap of snapshots) {
         const delta = Math.max(0, snap.ledger - lastLedger);
         conviction = stepConviction(conviction, totalStaked, delta, this.alphaBps);
         totalStaked = snap.totalStaked;
         if (snap.threshold > 0n) threshold = snap.threshold;
         lastLedger = snap.ledger;
      }

      if (snapshots.length === 0) {
         totalStaked = activeStakes.reduce((sum, s) => sum + s.amount, 0n);
      } else {
         const remainingDelta = Math.max(0, currentLedger - lastLedger);
         conviction = stepConviction(
            conviction,
            totalStaked,
            remainingDelta,
            this.alphaBps
         );
      }

      if (threshold === 0n && proposal?.snapshotTotalWeight) {
         try {
            threshold = BigInt(proposal.snapshotTotalWeight);
         } catch {
            threshold = 0n;
         }
      }

      const projectedCrossingLedger = executed
         ? currentLedger
         : projectCrossingLedger(
              conviction,
              totalStaked,
              threshold,
              currentLedger,
              this.alphaBps
           );

      let walletStake: ConvictionProgressResult['walletStake'] = undefined;
      if (wallet) {
         const stake = await prisma.convictionStake.findUnique({
            where: { proposalId_wallet: { proposalId, wallet } },
         });
         walletStake = stake
            ? {
                 wallet: stake.wallet,
                 amount: stake.amount.toString(),
                 isActive: stake.isActive,
                 stakedAtLedger: stake.stakedAtLedger,
              }
            : null;
      }

      const result: ConvictionProgressResult = {
         proposalId,
         conviction: conviction.toString(),
         threshold: threshold.toString(),
         totalStaked: totalStaked.toString(),
         currentLedger,
         projectedCrossingLedger,
         executed,
         ...(wallet !== undefined ? { walletStake } : {}),
      };

      if (options?.currentLedger === undefined) {
         await cacheSetJson(cacheKey, result, CONVICTION_CACHE_TTL_SECONDS);
      }

      return result;
   }

   async getRagequitStatus(
      proposalId: string,
      options?: { wallet?: string; currentLedger?: number }
   ): Promise<RagequitStatusResult> {
      const wallet = options?.wallet;
      const cacheKey = ragequitCacheKey(proposalId, wallet);

      if (options?.currentLedger === undefined) {
         const cached = await cacheGetJson<RagequitStatusResult>(cacheKey);
         if (cached !== null) return cached;
      }

      const [proposal, executedSnap, exits, latestLedgerRow] = await Promise.all([
         prisma.governanceProposal.findFirst({
            where: { OR: [{ id: proposalId }, { proposalId }] },
            select: {
               proposalId: true,
               snapshotLedger: true,
               snapshotTotalWeight: true,
               executedAt: true,
               status: true,
            },
         }),
         prisma.convictionSnapshot.findFirst({
            where: { proposalId, executed: true },
            orderBy: { ledger: 'desc' },
         }),
         prisma.ragequitExit.findMany({
            where: { proposalId },
         }),
         prisma.ledgerCheckpoint.findFirst({
            orderBy: { ledger: 'desc' },
            select: { ledger: true },
         }),
      ]);

      if (!proposal && !executedSnap && exits.length === 0) {
         throw new ConvictionProposalNotFoundError(proposalId);
      }

      const currentLedger =
         options?.currentLedger ??
         latestLedgerRow?.ledger ??
         executedSnap?.ledger ??
         proposal?.snapshotLedger ??
         0;

      const windowStartLedger = executedSnap?.ledger ?? null;
      const windowEndLedger =
         windowStartLedger !== null
            ? windowStartLedger + DEFAULT_RAGEQUIT_WINDOW_LEDGERS
            : null;

      const windowOpen =
         windowStartLedger !== null &&
         windowEndLedger !== null &&
         currentLedger >= windowStartLedger &&
         currentLedger <= windowEndLedger;

      const totalExits = exits.reduce((sum, e) => sum + e.amount, 0n);
      const baseWeight = executedSnap?.totalStaked ?? 0n;
      const exitCap =
         baseWeight > 0n
            ? (baseWeight * DEFAULT_RAGEQUIT_CAP_BPS) / BPS_SCALE
            : 0n;
      const remainingCap = exitCap > totalExits ? exitCap - totalExits : 0n;

      let eligible: boolean | null = null;
      let eligibilityReason: string | null = null;

      if (wallet) {
         const alreadyExited = exits.some(e => e.wallet === wallet);
         const stake = await prisma.convictionStake.findUnique({
            where: { proposalId_wallet: { proposalId, wallet } },
         });

         if (!windowOpen) {
            eligible = false;
            eligibilityReason =
               windowStartLedger === null
                  ? 'Proposal has not been executed'
                  : 'Rage-quit window has closed';
         } else if (alreadyExited) {
            eligible = false;
            eligibilityReason = 'Wallet has already rage-quit this proposal';
         } else if (!stake || !stake.isActive || stake.amount <= 0n) {
            eligible = false;
            eligibilityReason = 'Wallet has no active stake on this proposal';
         } else if (stake.amount > remainingCap) {
            eligible = false;
            eligibilityReason = 'Rage-quit cap exceeded';
         } else {
            eligible = true;
            eligibilityReason = null;
         }
      }

      const result: RagequitStatusResult = {
         proposalId,
         windowOpen,
         windowStartLedger,
         windowEndLedger,
         totalExits: totalExits.toString(),
         exitCap: exitCap.toString(),
         remainingCap: remainingCap.toString(),
         eligible,
         eligibilityReason,
      };

      if (options?.currentLedger === undefined) {
         await cacheSetJson(cacheKey, result, CONVICTION_CACHE_TTL_SECONDS);
      }

      return result;
   }
}

export const convictionService = new ConvictionService();
