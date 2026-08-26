// src/modules/referrals/referrals.service.ts
// Aggregates referral fee earnings per wallet.

import { prisma } from '../../utils/prisma.utils';
import { invalidateReferralSummary } from './referrals.cache';

export interface ReferralBreakdownItem {
   keyId: string;
   creatorName: string;
   amount: number;
   timestamp: string; // ISO-8601
}

export interface ReferralSummary {
   totalEarned: number; // XLM
   referralCount: number;
}

export interface ReferralBreakdownPage {
   items: ReferralBreakdownItem[];
   nextCursor: string | null;
   hasNextPage: boolean;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function toNumber(value: unknown): number {
   if (value == null) return 0;
   if (typeof value === 'number') return value;
   try {
      return Number(value.toString());
   } catch {
      return 0;
   }
}

/**
 * Returns the aggregated totals for a wallet across all referral fees received.
 */
export async function getReferralSummary(
   wallet: string
): Promise<ReferralSummary> {
   const result = await prisma.referralFee.aggregate({
      where: { wallet },
      _sum: { amount: true },
      _count: true,
   });

   return {
      totalEarned: toNumber(result._sum.amount),
      referralCount: result._count,
   };
}

function encodeCursor(createdAt: Date, id: string): string {
   return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
   try {
      const decoded = Buffer.from(cursor, 'base64').toString('utf8');
      const [iso, id] = decoded.split('|');
      if (!iso || !id) return null;
      const createdAt = new Date(iso);
      if (Number.isNaN(createdAt.getTime())) return null;
      return { createdAt, id };
   } catch {
      return null;
   }
}

export interface ReferralBreakdownQuery {
   cursor?: string;
   limit?: number;
}

/**
 * Returns a cursor-paginated breakdown of referral events for a wallet, newest
 * first. The cursor encodes the (createdAt, id) of the last item on the
 * previous page.
 */
export async function getReferralBreakdown(
   wallet: string,
   query: ReferralBreakdownQuery
): Promise<ReferralBreakdownPage> {
   const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

   const cursor = query.cursor ? decodeCursor(query.cursor) : null;

   const where: Record<string, unknown> = { wallet };
   if (cursor) {
      where.OR = [
         { createdAt: { lt: cursor.createdAt } },
         { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ];
   }

   const rows = await prisma.referralFee.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
   });

   const hasNextPage = rows.length > limit;
   const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
   const last = pageRows[pageRows.length - 1];

   const items: ReferralBreakdownItem[] = pageRows.map((row) => ({
      keyId: row.keyId,
      creatorName: row.creatorName,
      amount: toNumber(row.amount),
      timestamp: row.createdAt.toISOString(),
   }));

   return {
      items,
      nextCursor:
         hasNextPage && last ? encodeCursor(last.createdAt, last.id) : null,
      hasNextPage,
   };
}

export interface RecordReferralFeeInput {
   wallet: string;
   keyId: string;
   creatorId: string;
   creatorName: string;
   amount: number;
   txHash: string;
}

/**
 * Persists a referral fee payment and invalidates the wallet's cached summary.
 * This is the single entry point used when a `referral_fee_paid` event is
 * received from the chain/indexer.
 */
export async function recordReferralFee(
   input: RecordReferralFeeInput
): Promise<void> {
   await prisma.referralFee.create({
      data: {
         wallet: input.wallet,
         keyId: input.keyId,
         creatorId: input.creatorId,
         creatorName: input.creatorName,
         amount: input.amount,
         txHash: input.txHash,
      },
   });
   await invalidateReferralSummary(input.wallet);
}
