// src/modules/users/referrals.service.ts
// Aggregation + pagination for referral earnings surfaced from the on-chain
// `referral_fee_paid` event stream (persisted in ReferralEvent).

import { prisma } from '../../utils/prisma.utils';
import {
   encodeCursor,
   decodeCursor,
   CursorChecksumError,
} from '../../utils/cursor.utils';
import {
   ReferralBreakdownItem,
   ReferralBreakdownQueryType,
   ReferralCursorPayload,
   ReferralSummary,
} from './referrals.schemas';

export interface ReferralBreakdownPage {
   items: ReferralBreakdownItem[];
   nextCursor: string | null;
}

export interface ReferralEventInput {
   walletAddress: string;
   keyId: string;
   creatorId?: string | null;
   amount: number;
   txHash?: string | null;
   eventIndex?: number | null;
   createdAt?: Date;
}

/**
 * Persist a `referral_fee_paid` event. Intended to be called by the indexer
 * when the event is observed on-chain.
 */
export async function recordReferralEvent(
   input: ReferralEventInput
): Promise<void> {
   await prisma.referralEvent.create({
      data: {
         walletAddress: input.walletAddress,
         keyId: input.keyId,
         ...(input.creatorId ? { creatorId: input.creatorId } : {}),
         amount: input.amount,
         ...(input.txHash ? { txHash: input.txHash } : {}),
         ...(input.eventIndex !== undefined && input.eventIndex !== null
            ? { eventIndex: input.eventIndex }
            : {}),
         ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      },
   });
}

/**
 * Total XLM earned and count of referral fee payments for a wallet.
 */
export async function getReferralSummary(
   wallet: string
): Promise<ReferralSummary> {
   const aggregate = await prisma.referralEvent.aggregate({
      where: { walletAddress: wallet },
      _sum: { amount: true },
      _count: { _all: true },
   });

   return {
      totalEarned: Number(aggregate._sum.amount ?? 0),
      referralCount: aggregate._count._all,
   };
}

/**
 * Cursor-paginated breakdown of individual referral events, newest first.
 *
 * The cursor encodes `(createdAt, id)` of the last row of the previous page,
 * giving stable keyset pagination even when new events arrive between pages.
 */
export async function getReferralBreakdown(
   wallet: string,
   query: ReferralBreakdownQueryType
): Promise<ReferralBreakdownPage> {
   const cursorFilter = parseReferralCursor(query.cursor);

   const rows = await prisma.referralEvent.findMany({
      where: { walletAddress: wallet },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
      ...(cursorFilter
         ? {
              where: {
                 walletAddress: wallet,
                 OR: [
                    { createdAt: { lt: new Date(cursorFilter.createdAt) } },
                    {
                       createdAt: { lte: new Date(cursorFilter.createdAt) },
                       id: { lt: cursorFilter.id },
                    },
                 ],
              },
           }
         : {}),
   });

   const creatorIds = [
      ...new Set(
         rows
            .map((row) => row.creatorId)
            .filter((id): id is string => Boolean(id))
      ),
   ];

   const creators = creatorIds.length
      ? await prisma.creatorProfile.findMany({
           where: {
              OR: [{ id: { in: creatorIds } }, { handle: { in: creatorIds } }],
           },
           select: { id: true, handle: true, displayName: true },
        })
      : [];

   // creatorId may store either the profile id or the handle depending on how
   // the trade was indexed, so map both identifiers to a display name.
   const nameByIdentifier = new Map<string, string>();
   for (const creator of creators) {
      nameByIdentifier.set(creator.id, creator.displayName);
      nameByIdentifier.set(creator.handle, creator.displayName);
   }

   const items: ReferralBreakdownItem[] = rows.map((row) => ({
      keyId: row.keyId,
      creatorName:
         (row.creatorId ? nameByIdentifier.get(row.creatorId) : undefined) ??
         null,
      amount: Number(row.amount),
      timestamp: row.createdAt.toISOString(),
   }));

   const lastRow = rows.at(-1);
   const nextCursor = lastRow
      ? encodeCursor({
           createdAt: lastRow.createdAt.toISOString(),
           id: lastRow.id,
        })
      : null;

   return { items, nextCursor };
}

function parseReferralCursor(
   cursor: string | undefined
): ReferralCursorPayload | null {
   if (!cursor) return null;
   try {
      return decodeCursor<ReferralCursorPayload>(cursor);
   } catch (error) {
      if (error instanceof CursorChecksumError) {
         throw error;
      }
      throw new CursorChecksumError('Invalid cursor');
   }
}
