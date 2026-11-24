// src/modules/token-rescue/token-rescue.service.ts
// Read side of TokenRescue (#1271): the admin report and the public totals.

import { prisma } from '../../utils/prisma.utils';

export const TOKEN_RESCUE_DEFAULT_LIMIT = 20;
export const TOKEN_RESCUE_MAX_LIMIT = 100;

export class InvalidTokenRescueCursorError extends Error {
   constructor(cursor: string) {
      super(`Invalid rescue cursor: ${cursor}`);
      this.name = 'InvalidTokenRescueCursorError';
   }
}

/** Per-token running totals. Safe for the public transparency endpoint. */
export interface TokenRescueTotal {
   token: string;
   totalAmount: string;
   rescueCount: number;
   lastRescueLedger: number | null;
}

/** Full rescue record. Admin-only: includes recipient, admin and txHash. */
export interface AdminTokenRescueItem {
   id: string;
   token: string;
   recipient: string;
   amount: string;
   admin: string;
   ledger: number;
   txHash: string;
   eventIndex: number;
   indexedAt: Date;
}

export interface AdminTokenRescuePage {
   items: AdminTokenRescueItem[];
   nextCursor: string | null;
   totals: TokenRescueTotal[];
}

export async function getTokenRescueTotals(): Promise<TokenRescueTotal[]> {
   const groups = await prisma.tokenRescue.groupBy({
      by: ['token'],
      _sum: { amount: true },
      _count: { _all: true },
      _max: { ledger: true },
      orderBy: { token: 'asc' },
   });
   return groups.map(group => ({
      token: group.token,
      totalAmount: (group._sum.amount ?? 0n).toString(),
      rescueCount: group._count._all,
      lastRescueLedger: group._max.ledger ?? null,
   }));
}

/**
 * Admin report: newest rescues first, optionally filtered by token, with
 * cursor pagination. `cursor` is the id of the last item on the previous page.
 */
export async function listTokenRescuesForAdmin(options: {
   token?: string;
   cursor?: string;
   limit?: number;
}): Promise<AdminTokenRescuePage> {
   const limit = Math.min(
      Math.max(options.limit ?? TOKEN_RESCUE_DEFAULT_LIMIT, 1),
      TOKEN_RESCUE_MAX_LIMIT
   );

   let cursorArgs:
      | { cursor: { id: string }; skip: number }
      | undefined;
   if (options.cursor !== undefined) {
      const cursorRow = await prisma.tokenRescue.findUnique({
         where: { id: options.cursor },
         select: { id: true },
      });
      if (!cursorRow) throw new InvalidTokenRescueCursorError(options.cursor);
      cursorArgs = { cursor: { id: options.cursor }, skip: 1 };
   }

   const rows = await prisma.tokenRescue.findMany({
      where: options.token ? { token: options.token } : {},
      orderBy: [{ ledger: 'desc' }, { eventIndex: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...cursorArgs,
   });
   const hasMore = rows.length > limit;
   const pageRows = hasMore ? rows.slice(0, limit) : rows;

   return {
      items: pageRows.map(row => ({
         id: row.id,
         token: row.token,
         recipient: row.recipient,
         amount: row.amount.toString(),
         admin: row.admin,
         ledger: row.ledger,
         txHash: row.txHash,
         eventIndex: row.eventIndex,
         indexedAt: row.indexedAt,
      })),
      nextCursor: hasMore ? pageRows[pageRows.length - 1].id : null,
      totals: await getTokenRescueTotals(),
   };
}
