// src/modules/referrals/referral-hold.service.ts
// Admin review of referral rewards withheld by abuse detection (#1241).
//
// A PENDING hold can be released (pays the withheld reward) or rejected (never
// pays). Resolution is a conditional PENDING -> RELEASED/REJECTED update in the
// same transaction as the payout, so two concurrent releases, or a release
// replayed after a timeout, can only ever pay once. REJECTED holds created by
// detection itself (self-referral, shared funding, linked wallets) are final.

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
   keyId: string;
   rewardXlm: number;
   tradedAt: string;
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
   keyId: string;
   rewardXlm: unknown;
   txHash: string | null;
   eventIndex: number | null;
   tradedAt: Date;
   resolvedBy: string | null;
   resolvedAt: Date | null;
   createdAt: Date;
}

function toView(row: HoldRow): ReferralHoldView {
   return {
      id: row.id,
      referralId: row.referralId,
      reason: row.reason,
      status: row.status,
      details: row.details ?? null,
      referrerAddress: row.referrerAddress,
      refereeAddress: row.refereeAddress,
      keyId: row.keyId,
      rewardXlm: roundXlm(Number(row.rewardXlm)),
      tradedAt: row.tradedAt.toISOString(),
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

   return buildPaginatedResponse(rows.map(toView), limit, item =>
      encodeCursor({ createdAt: item.createdAt, id: item.id })
   );
}

/**
 * Releases or rejects a PENDING hold. Releasing pays the withheld reward
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

   const resolved = await prisma.$transaction(async tx => {
      const existing = (await tx.referralHold.findUnique({
         where: { id },
      })) as HoldRow | null;
      if (!existing) {
         throw new ReferralHoldNotFoundError(id);
      }

      // The status guard is the once-only gate: only one caller can move a
      // hold out of PENDING, and only that caller pays.
      const claimed = await tx.referralHold.updateMany({
         where: { id, status: 'PENDING' },
         data: { status: resolution, resolvedBy: adminId, resolvedAt },
      });
      if (claimed.count === 0) {
         throw new ReferralHoldAlreadyResolvedError(id, existing.status);
      }

      if (resolution === 'RELEASED' && Number(existing.rewardXlm) > 0) {
         await tx.referralEvent.create({
            data: {
               walletAddress: existing.referrerAddress,
               refereeAddress: existing.refereeAddress,
               keyId: existing.keyId,
               amount: existing.rewardXlm as number,
               ...(existing.txHash ? { txHash: existing.txHash } : {}),
               ...(existing.eventIndex !== null &&
               existing.eventIndex !== undefined
                  ? { eventIndex: existing.eventIndex }
                  : {}),
               createdAt: existing.tradedAt,
            },
         });
      }

      return {
         ...existing,
         status: resolution,
         resolvedBy: adminId,
         resolvedAt,
      } as HoldRow;
   });

   logger.info(
      {
         type:
            resolution === 'RELEASED'
               ? 'referral_hold_released'
               : 'referral_hold_rejected',
         holdId: id,
         adminId,
         referrerAddress: resolved.referrerAddress,
         refereeAddress: resolved.refereeAddress,
         rewardXlm: Number(resolved.rewardXlm),
      },
      'Referral hold resolved'
   );

   return toView(resolved);
}
