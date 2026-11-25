// src/services/referral-abuse.service.ts
// Referral abuse detection (#1241).
//
// `evaluate` classifies a referral before its reward is paid:
//
//   reject  SELF_REFERRAL           referrer and referee are the same wallet
//   reject  LINKED_WALLETS          one wallet funded the other
//   reject  SHARED_FUNDING_SOURCE   both wallets were first funded by the same
//                                   account
//   hold    FUNDING_CLUSTER         more than CLUSTER_THRESHOLD referees were
//                                   first funded by the referee's funder
//                                   inside one CLUSTER_WINDOW_MS window
//   allow   otherwise
//
// A reject is final. A hold withholds the reward until an admin reviews it.
// Funders on REFERRAL_ABUSE_FUNDER_ALLOWLIST (exchange or anchor hot wallets)
// never trigger the shared-funding or cluster rules, since unrelated users
// legitimately share them.

import { envConfig } from '../config';
import { prisma } from '../utils/prisma.utils';
import { getFundingSource, WalletFunding } from './wallet-funding.service';

/** More than this many referees in one window is a cluster. */
export const CLUSTER_THRESHOLD = 5;
/** "Within 24 hours": inclusive window length. */
export const CLUSTER_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Upper bound on funding rows loaded for a single cluster check. */
const CLUSTER_QUERY_LIMIT = 1000;

export type ReferralAbuseReason =
   | 'SELF_REFERRAL'
   | 'LINKED_WALLETS'
   | 'SHARED_FUNDING_SOURCE'
   | 'FUNDING_CLUSTER';

export type ReferralAbuseDecision =
   | { action: 'allow' }
   | {
        action: 'reject' | 'hold';
        reason: ReferralAbuseReason;
        details: Record<string, unknown>;
     };

export interface ReferralToEvaluate {
   referrerAddress: string;
   refereeAddress: string;
}

function allowlistedFunders(): Set<string> {
   const raw = envConfig.REFERRAL_ABUSE_FUNDER_ALLOWLIST;
   if (!raw) return new Set();
   return new Set(
      raw
         .split(',')
         .map(entry => entry.trim())
         .filter(Boolean)
   );
}

/**
 * Size of the busiest window of `windowMs` that contains `anchor`: the most
 * timestamps any such window holds (0 when none contains the anchor).
 */
export function densestWindowCount(
   times: Date[],
   anchor: Date,
   windowMs: number = CLUSTER_WINDOW_MS
): number {
   const sorted = times.map(t => t.getTime()).sort((a, b) => a - b);
   const anchorMs = anchor.getTime();
   let best = 0;
   for (const start of sorted) {
      const end = start + windowMs;
      if (anchorMs < start || anchorMs > end) continue;
      let count = 0;
      for (const t of sorted) {
         if (t >= start && t <= end) count += 1;
      }
      if (count > best) best = count;
   }
   return best;
}

/** True when a window containing `anchor` holds more than `threshold` times. */
export function hasDenseWindow(
   times: Date[],
   anchor: Date,
   windowMs: number = CLUSTER_WINDOW_MS,
   threshold: number = CLUSTER_THRESHOLD
): boolean {
   return densestWindowCount(times, anchor, windowMs) > threshold;
}

/** Referees (with a known funding time) first funded by `funder` near `at`. */
async function fundingTimesForFunder(
   funder: string,
   at: Date
): Promise<Array<{ address: string; fundedAt: Date }>> {
   const sources = await prisma.walletFundingSource.findMany({
      where: {
         funder,
         fundedAt: {
            gte: new Date(at.getTime() - CLUSTER_WINDOW_MS),
            lte: new Date(at.getTime() + CLUSTER_WINDOW_MS),
         },
      },
      select: { address: true, fundedAt: true },
      orderBy: { fundedAt: 'asc' },
      take: CLUSTER_QUERY_LIMIT,
   });
   if (sources.length === 0) return [];

   const referees = await prisma.referral.findMany({
      where: { refereeAddress: { in: sources.map(s => s.address) } },
      select: { refereeAddress: true },
   });
   const refereeSet = new Set(referees.map(r => r.refereeAddress));
   return sources.filter(s => refereeSet.has(s.address));
}

export const ReferralAbuseService = {
   /**
    * Evaluates a referral against every rule, cheapest first.
    *
    * @throws {FundingLookupError} when Horizon is unavailable and a funding
    *   source is needed. Callers should retry, not pay.
    */
   async evaluate(
      referral: ReferralToEvaluate
   ): Promise<ReferralAbuseDecision> {
      const { referrerAddress, refereeAddress } = referral;

      if (referrerAddress === refereeAddress) {
         return {
            action: 'reject',
            reason: 'SELF_REFERRAL',
            details: { wallet: refereeAddress },
         };
      }

      const [referrerFunding, refereeFunding]: Array<WalletFunding | null> =
         await Promise.all([
            getFundingSource(referrerAddress),
            getFundingSource(refereeAddress),
         ]);

      // Linked wallets: one funded the other.
      if (refereeFunding?.funder === referrerAddress) {
         return {
            action: 'reject',
            reason: 'LINKED_WALLETS',
            details: { fundedBy: 'referrer', funder: referrerAddress },
         };
      }
      if (referrerFunding?.funder === refereeAddress) {
         return {
            action: 'reject',
            reason: 'LINKED_WALLETS',
            details: { fundedBy: 'referee', funder: refereeAddress },
         };
      }

      const funder = refereeFunding?.funder;
      if (!refereeFunding || !funder || allowlistedFunders().has(funder)) {
         return { action: 'allow' };
      }

      if (referrerFunding?.funder === funder) {
         return {
            action: 'reject',
            reason: 'SHARED_FUNDING_SOURCE',
            details: { funder },
         };
      }

      const cluster = await fundingTimesForFunder(
         funder,
         refereeFunding.fundedAt
      );
      const times = cluster.some(c => c.address === refereeAddress)
         ? cluster.map(c => c.fundedAt)
         : [...cluster.map(c => c.fundedAt), refereeFunding.fundedAt];

      const clusterSize = densestWindowCount(times, refereeFunding.fundedAt);
      if (clusterSize > CLUSTER_THRESHOLD) {
         return {
            action: 'hold',
            reason: 'FUNDING_CLUSTER',
            details: {
               funder,
               refereesInWindow: clusterSize,
               threshold: CLUSTER_THRESHOLD,
               windowHours: CLUSTER_WINDOW_MS / 3_600_000,
            },
         };
      }

      return { action: 'allow' };
   },
};
