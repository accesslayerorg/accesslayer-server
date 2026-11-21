// src/modules/referrals/referral-earnings.service.ts
// Query + persistence logic for referral reward earnings (#1057).
//
// Reads are backed by the `ReferralEarning` read model (table
// `referral_earnings`) which is populated by the indexer from on-chain
// `ReferralRewardDistributed` events. The earnings list is keyset-paginated
// (newest first) and supports an optional `[from, to]` date range.

import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import {
   cacheInvalidate,
   cacheGetJson,
   cacheSetJson,
} from '../../utils/redis.utils';
import {
   CursorChecksumError,
   decodeCursor,
   encodeCursor,
} from '../../utils/cursor.utils';
import {
   buildReferralEarningsSummaryCacheKey,
   REFERRAL_EARNINGS_SUMMARY_CACHE_TTL_SECONDS,
   referralEarningsCachePattern,
} from './referral-earnings.constants';
import {
   ReferralEarningItem,
   ReferralEarningsCursorPayload,
   ReferralEarningsSummary,
} from './referral-earnings.schemas';

export interface ReferralEarningsPage {
   items: ReferralEarningItem[];
   pagination: {
      limit: number;
      hasMore: boolean;
      nextCursor?: string;
   };
}

export interface GetReferralEarningsInput {
   wallet: string;
   limit: number;
   cursor?: string;
   /** Inclusive lower bound (ISO date or timestamp). */
   from?: string;
   /** Inclusive upper bound (ISO date or timestamp). */
   to?: string;
}

/** Fields the indexer supplies when a reward event is observed on-chain. */
export interface ReferralEarningInput {
   referrerWallet: string;
   sourceWallet: string;
   tier: number;
   amount: number;
   txHash: string;
   eventIndex: number;
   ledger: number;
   earnedAt: Date;
}

/**
 * Persist a single `ReferralRewardDistributed` reward. The
 * `(txHash, eventIndex)` unique constraint makes replays idempotent, and the
 * affected wallet's cached summary/pages are invalidated so the next read
 * reflects the new reward immediately.
 */
export async function recordReferralEarning(
   input: ReferralEarningInput
): Promise<void> {
   await prisma.referralEarning.upsert({
      where: {
         txHash_eventIndex: {
            txHash: input.txHash,
            eventIndex: input.eventIndex,
         },
      },
      create: {
         referrerWallet: input.referrerWallet,
         sourceWallet: input.sourceWallet,
         tier: input.tier,
         amount: input.amount,
         txHash: input.txHash,
         eventIndex: input.eventIndex,
         ledger: input.ledger,
         earnedAt: input.earnedAt,
      },
      // Duplicate event (already indexed): update nothing.
      update: {},
   });

   await cacheInvalidate(
      buildReferralEarningsSummaryCacheKey(input.referrerWallet),
      referralEarningsCachePattern(input.referrerWallet)
   );
}

/**
 * Cursor-paginated earnings history for a wallet, newest first.
 *
 * Uses keyset pagination on `(earnedAt, id)` so results stay consistent even
 * when new rewards arrive between page fetches. `from`/`to` narrow the window
 * (both inclusive).
 */
export async function getReferralEarnings(
   input: GetReferralEarningsInput
): Promise<ReferralEarningsPage> {
   const { wallet, limit, cursor, from, to } = input;

   const earnedAtFilter: Prisma.DateTimeFilter = {};
   if (from) earnedAtFilter.gte = new Date(from);
   if (to) earnedAtFilter.lte = new Date(to);

   const where: Prisma.ReferralEarningWhereInput = { referrerWallet: wallet };
   if (earnedAtFilter.gte || earnedAtFilter.lte) {
      where.earnedAt = earnedAtFilter;
   }

   const cursorPayload = parseReferralEarningsCursor(cursor);
   if (cursorPayload) {
      where.AND = [
         {
            OR: [
               { earnedAt: { lt: new Date(cursorPayload.earnedAt) } },
               {
                  earnedAt: new Date(cursorPayload.earnedAt),
                  id: { lt: cursorPayload.id },
               },
            ],
         },
      ];
   }

   const rows = await prisma.referralEarning.findMany({
      where,
      orderBy: [{ earnedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
   });

   const hasMore = rows.length > limit;
   const page = rows.slice(0, limit);
   const last = page.at(-1);

   return {
      items: page.map(row => ({
         id: row.id,
         tier: row.tier,
         amount: Number(row.amount),
         sourceWallet: row.sourceWallet,
         earnedAt: row.earnedAt.toISOString(),
         txHash: row.txHash ?? null,
      })),
      pagination: {
         limit,
         hasMore,
         nextCursor:
            hasMore && last
               ? encodeCursor<ReferralEarningsCursorPayload>({
                    earnedAt: last.earnedAt.toISOString(),
                    id: last.id,
                 })
               : undefined,
      },
   };
}

/**
 * Total earnings, per-tier breakdown, and count of distinct referred wallets.
 * Cached in Redis for {@link REFERRAL_EARNINGS_SUMMARY_CACHE_TTL_SECONDS}.
 */
export async function getReferralEarningsSummary(
   wallet: string
): Promise<ReferralEarningsSummary> {
   const cacheKey = buildReferralEarningsSummaryCacheKey(wallet);
   const cached = await cacheGetJson<ReferralEarningsSummary>(cacheKey);
   if (cached) {
      return cached;
   }

   const where: Prisma.ReferralEarningWhereInput = { referrerWallet: wallet };

   const [total, tierGroups, sourceWallets] = await Promise.all([
      prisma.referralEarning.aggregate({
         where,
         _sum: { amount: true },
         _count: { _all: true },
      }),
      prisma.referralEarning.groupBy({
         by: ['tier'],
         where,
         _sum: { amount: true },
      }),
      prisma.referralEarning.findMany({
         where,
         distinct: ['sourceWallet'],
         select: { sourceWallet: true },
      }),
   ]);

   const tiers = { tier1: 0, tier2: 0, tier3: 0 };
   for (const group of tierGroups) {
      const amount = Number(group._sum.amount ?? 0);
      if (group.tier === 1) tiers.tier1 = amount;
      else if (group.tier === 2) tiers.tier2 = amount;
      else if (group.tier === 3) tiers.tier3 = amount;
   }

   const summary: ReferralEarningsSummary = {
      totalEarnings: Number(total._sum.amount ?? 0),
      earningsCount: total._count._all,
      referredWalletCount: sourceWallets.length,
      tiers,
   };

   await cacheSetJson(
      cacheKey,
      summary,
      REFERRAL_EARNINGS_SUMMARY_CACHE_TTL_SECONDS
   );

   return summary;
}

function parseReferralEarningsCursor(
   cursor: string | undefined
): ReferralEarningsCursorPayload | null {
   if (!cursor) return null;
   try {
      return decodeCursor<ReferralEarningsCursorPayload>(cursor);
   } catch (error) {
      if (error instanceof CursorChecksumError) {
         throw error;
      }
      throw new CursorChecksumError('Invalid cursor');
   }
}
