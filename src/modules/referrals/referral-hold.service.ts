// src/modules/referrals/referral-hold.service.ts
// Admin review of referrals flagged by abuse detection (#1241).
//
// While a hold is PENDING every reward the referral earns is withheld as a
// `ReferralHoldReward` row (see `recordTradeReferralReward`). An admin can then:
//   - release: pay every withheld reward, once; later trades pay normally
//   - reject:  never pay; later trades are ignored
//
// Resolution is a conditional PENDING -> RELEASED/REJECTED update in the same
// transaction as the payout, so two concurrent releases, or a release replayed
// after a timeout, can only ever pay once. REJECTED holds created by detection
// itself (self-referral, shared funding, linked wallets) are final.

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   buildPaginatedResponse,
   PaginatedResponse,
} from '../../utils/pagination.utils';
import {
   CursorChecksumError,
   decodeCursor,
   encodeCursor,
} from '../../utils/cursor.utils';
import { roundXlm } from './referrals.service';

export type ReferralHoldStatusValue = 'PENDING' | 'RELEASED' | 'REJECTED';
export type ReferralHoldResolution = 'RELEASED' | 'REJECTED';

export const DEFAULT_REFERRAL_HOLD_PAGE_SIZE = 20;

export class ReferralHoldNotFoundError extends Error {
   constructor(id: string) {
      super(`Referral hold ${id} not found`);
      this.name = 'ReferralHoldNotFoundError';
   }
}

export class ReferralHoldAlreadyResolvedError extends Error {
   constructor(
      id: string,
      public readonly status: ReferralHoldStatusValue
   ) {
      super(`Referral hold ${id} is already ${status}`);
      this.name = 'ReferralHoldAlreadyResolvedError';
   }
}

export interface ReferralHoldView {
   id: string;
   referralId: string;
   reason: string;
   status: ReferralHoldStatusValue;
   details: unknown;
   referrerAddress: string;
   refereeAddress: string;
   /** Total XLM withheld across all trades held under this hold. */
   rewardXlm: number;
   /** Number of trades whose reward is held under this hold. */
   withheldTrades: number;
   resolvedBy: string | null;
   resolvedAt: string | null;
   createdAt: string;
}

interface HoldRow {
   id: string;
   referralId: string;
   reason: string;
   status: ReferralHoldStatusValue;
   details: unknown;
   referrerAddress: string;
   refereeAddress: string;
   resolvedBy: string | null;
   resolvedAt: Date | null;
   createdAt: Date;
}

interface WithheldTotals {
   rewardXlm: number;
   trades: number;
}

type RewardReader = Pick<typeof prisma, 'referralHoldReward'>;

/** Withheld reward totals per hold, in one grouped query. */
async function withheldTotals(
   db: RewardReader,
   holdIds: string[]
): Promise<Map<string, WithheldTotals>> {
   const totals = new Map<string, WithheldTotals>();
   if (holdIds.length === 0) return totals;

   const grouped = await db.referralHoldReward.groupBy({
      by: ['holdId'],
      where: { holdId: { in: holdIds } },
      _sum: { rewardXlm: true },
      _count: { _all: true },
   });
   for (const row of grouped) {
      totals.set(row.holdId, {
         rewardXlm: roundXlm(Number(row._sum.rewardXlm ?? 0)),
         trades: row._count._all,
      });
   }
   return totals;
}

function toView(row: HoldRow, totals?: WithheldTotals): ReferralHoldView {
   return {
      id: row.id,
      referralId: row.referralId,
      reason: row.reason,
      status: row.status,
      details: row.details ?? null,
      referrerAddress: row.referrerAddress,
      refereeAddress: row.refereeAddress,
      rewardXlm: totals?.rewardXlm ?? 0,
      withheldTrades: totals?.trades ?? 0,
      resolvedBy: row.resolvedBy,
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
   };
}

interface HoldCursor {
   createdAt: string;
   id: string;
}

function parseCursor(cursor: string | undefined): HoldCursor | null {
   if (!cursor) return null;
   let payload: HoldCursor;
   try {
      payload = decodeCursor<HoldCursor>(cursor);
   } catch {
      throw new CursorChecksumError('Invalid cursor');
   }
   if (
      typeof payload?.createdAt !== 'string' ||
      Number.isNaN(new Date(payload.createdAt).getTime()) ||
      typeof payload?.id !== 'string'
   ) {
      throw new CursorChecksumError('Invalid cursor');
   }
   return payload;
}

export interface ListReferralHoldsQuery {
   status?: ReferralHoldStatusValue;
   limit?: number;
   cursor?: string;
}

/** Cursor-paginated holds, newest first, optionally filtered by status. */
export async function listReferralHolds(
   query: ListReferralHoldsQuery = {}
): Promise<PaginatedResponse<ReferralHoldView>> {
   const limit = query.limit ?? DEFAULT_REFERRAL_HOLD_PAGE_SIZE;
   const cursor = parseCursor(query.cursor);

   const rows = (await prisma.referralHold.findMany({
      where: {
         ...(query.status ? { status: query.status } : {}),
         ...(cursor
            ? {
                 OR: [
                    { createdAt: { lt: new Date(cursor.createdAt) } },
                    {
                       createdAt: new Date(cursor.createdAt),
                       id: { lt: cursor.id },
                    },
                 ],
              }
            : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
   })) as HoldRow[];

   const page = rows.slice(0, limit);
   const totals = await withheldTotals(
      prisma,
      page.map(row => row.id)
   );

   // Build views for the whole fetch (including the look-ahead row) so
   // buildPaginatedResponse can slice and cursor as usual.
   return buildPaginatedResponse(
      rows.map(row => toView(row, totals.get(row.id))),
      limit,
      item => encodeCursor({ createdAt: item.createdAt, id: item.id })
   );
}

/**
 * Releases or rejects a PENDING hold. Releasing pays every withheld reward
 * exactly once, in the same transaction as the status change.
 *
 * @throws {ReferralHoldNotFoundError} when the hold does not exist
 * @throws {ReferralHoldAlreadyResolvedError} when it is not PENDING
 */
export async function resolveReferralHold(
   id: string,
   resolution: ReferralHoldResolution,
   adminId: string
): Promise<ReferralHoldView> {
   const resolvedAt = new Date();

   const { hold, totals } = await prisma.$transaction(async tx => {
      const existing = (await tx.referralHold.findUnique({
         where: { id },
      })) as HoldRow | null;
      if (!existing) {
         throw new ReferralHoldNotFoundError(id);
      }

      // The status guard is the once-only gate: only one caller can move a
      // hold out of PENDING, and only that caller pays. It also takes the row
      // lock that serialises against trades withholding a new reward, so the
      // rewards read below include every reward committed before release.
      const claimed = await tx.referralHold.updateMany({
         where: { id, status: 'PENDING' },
         data: { status: resolution, resolvedBy: adminId, resolvedAt },
      });
      if (claimed.count === 0) {
         throw new ReferralHoldAlreadyResolvedError(id, existing.status);
      }

      if (resolution === 'RELEASED') {
         const rewards = await tx.referralHoldReward.findMany({
            where: { holdId: id },
            orderBy: [{ tradedAt: 'asc' }, { id: 'asc' }],
         });
         if (rewards.length > 0) {
            await tx.referralEvent.createMany({
               data: rewards
                  .filter(reward => Number(reward.rewardXlm) > 0)
                  .map(reward => ({
                     walletAddress: existing.referrerAddress,
                     refereeAddress: existing.refereeAddress,
                     keyId: reward.keyId,
                     amount: reward.rewardXlm,
                     tierMultiplier: reward.tierMultiplier,
                     ...(reward.txHash ? { txHash: reward.txHash } : {}),
                     ...(reward.eventIndex !== null &&
                     reward.eventIndex !== undefined
                        ? { eventIndex: reward.eventIndex }
                        : {}),
                     createdAt: reward.tradedAt,
                  })),
            });
         }
      }

      const totals = await withheldTotals(tx, [id]);
      return {
         hold: {
            ...existing,
            status: resolution,
            resolvedBy: adminId,
            resolvedAt,
         } as HoldRow,
         totals: totals.get(id),
      };
   });

   logger.info(
      {
         type:
            resolution === 'RELEASED'
               ? 'referral_hold_released'
               : 'referral_hold_rejected',
         holdId: id,
         adminId,
         referrerAddress: hold.referrerAddress,
         refereeAddress: hold.refereeAddress,
         rewardXlm: totals?.rewardXlm ?? 0,
         withheldTrades: totals?.trades ?? 0,
      },
      'Referral hold resolved'
   );

   return toView(hold, totals);
}
