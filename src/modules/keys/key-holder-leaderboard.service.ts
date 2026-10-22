// src/modules/keys/key-holder-leaderboard.service.ts
// Holder leaderboard per creator key (#1013).
//
// Ranking is deterministic: balance DESC, then first-purchase date ASC (the
// earlier holder wins a tie), then wallet address ASC. The same comparator is
// used by the list, the cursor pages and the single-wallet rank lookup so a
// wallet's rank always agrees with its position in the list.

import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   cacheGetJson,
   cacheInvalidate,
   cacheSetJson,
} from '../../utils/redis.utils';
import {
   encodeCursor,
   decodeCursor,
} from '../../utils/cursor.utils';
import { MAX_PAGE_SIZE } from '../../constants/pagination.constants';

/** Number of holders returned on the first (cached) page. */
export const HOLDER_LEADERBOARD_TOP_N = MAX_PAGE_SIZE; // 100
/** Cache TTL: leaderboard is refreshed at least every 5 minutes. */
export const HOLDER_LEADERBOARD_CACHE_TTL_SECONDS = 5 * 60;

export const holderLeaderboardCacheKey = (creatorId: string): string =>
   `key:holder-leaderboard:${creatorId}`;

export class HolderLeaderboardKeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'HolderLeaderboardKeyNotFoundError';
   }
}

export class HolderNotFoundError extends Error {
   constructor(wallet: string) {
      super(`Wallet is not a holder of this key: ${wallet}`);
      this.name = 'HolderNotFoundError';
   }
}

export class InvalidHolderCursorError extends Error {
   constructor() {
      super('Invalid or expired cursor');
      this.name = 'InvalidHolderCursorError';
   }
}

export interface HolderLeaderboardEntry {
   rank: number;
   wallet_address: string;
   balance: number;
   /** Share of total supply held, 0-100. */
   supply_percent: number;
   /** ISO timestamp of the wallet's first purchase of this key. */
   since: string;
}

export interface HolderLeaderboardPage {
   keyId: string;
   totalSupply: number;
   totalHolders: number;
   items: HolderLeaderboardEntry[];
   nextCursor: string | null;
   hasMore: boolean;
}

export interface HolderRank {
   keyId: string;
   wallet_address: string;
   rank: number;
   balance: number;
   supply_percent: number;
   since: string;
   totalHolders: number;
}

/** Shape stored in Redis: the top-N snapshot for one key. */
interface HolderLeaderboardSnapshot {
   keyId: string;
   totalSupply: number;
   totalHolders: number;
   items: HolderLeaderboardEntry[];
   computedAt: string;
}

interface ResolvedKey {
   id: string;
   circulatingSupply: number;
}

const ORDER_BY: Prisma.KeyOwnershipOrderByWithRelationInput[] = [
   { balance: 'desc' },
   { createdAt: 'asc' },
   { ownerAddress: 'asc' },
];

export async function resolveKey(keyIdOrHandle: string): Promise<ResolvedKey> {
   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyIdOrHandle }, { handle: keyIdOrHandle }] },
      select: { id: true, circulatingSupply: true },
   });
   if (!creator) {
      throw new HolderLeaderboardKeyNotFoundError(keyIdOrHandle);
   }
   return {
      id: creator.id,
      circulatingSupply: Number(creator.circulatingSupply ?? 0),
   };
}

/**
 * Supply used as the denominator for the supply percentage: the key's
 * circulating supply, falling back to the sum of holder balances when the
 * supply has not been persisted yet.
 */
async function resolveTotalSupply(
   creatorId: string,
   circulatingSupply: number
): Promise<number> {
   if (circulatingSupply > 0) return circulatingSupply;
   const agg = await prisma.keyOwnership.aggregate({
      where: { creatorId, balance: { gt: 0 } },
      _sum: { balance: true },
   });
   return Number(agg._sum.balance ?? 0);
}

function toEntry(
   row: { ownerAddress: string; balance: unknown; createdAt: Date },
   rank: number,
   totalSupply: number
): HolderLeaderboardEntry {
   const balance = Number(row.balance);
   return {
      rank,
      wallet_address: row.ownerAddress,
      balance,
      supply_percent: totalSupply > 0 ? (balance / totalSupply) * 100 : 0,
      since: row.createdAt.toISOString(),
   };
}

/** Rows strictly ahead of (balance, createdAt, ownerAddress) in rank order. */
function aheadOf(
   balance: unknown,
   createdAt: Date,
   ownerAddress: string
): Prisma.KeyOwnershipWhereInput[] {
   return [
      { balance: { gt: balance as Prisma.Decimal } },
      { balance: balance as Prisma.Decimal, createdAt: { lt: createdAt } },
      {
         balance: balance as Prisma.Decimal,
         createdAt,
         ownerAddress: { lt: ownerAddress },
      },
   ];
}

/** Rows strictly behind (balance, createdAt, ownerAddress) in rank order. */
function behind(
   balance: unknown,
   createdAt: Date,
   ownerAddress: string
): Prisma.KeyOwnershipWhereInput[] {
   return [
      { balance: { lt: balance as Prisma.Decimal, gt: 0 } },
      { balance: balance as Prisma.Decimal, createdAt: { gt: createdAt } },
      {
         balance: balance as Prisma.Decimal,
         createdAt,
         ownerAddress: { gt: ownerAddress },
      },
   ];
}

async function computeSnapshot(
   key: ResolvedKey
): Promise<HolderLeaderboardSnapshot> {
   const where: Prisma.KeyOwnershipWhereInput = {
      creatorId: key.id,
      balance: { gt: 0 },
   };

   const [rows, totalHolders, totalSupply] = await Promise.all([
      prisma.keyOwnership.findMany({
         where,
         orderBy: ORDER_BY,
         take: HOLDER_LEADERBOARD_TOP_N,
         select: { ownerAddress: true, balance: true, createdAt: true },
      }),
      prisma.keyOwnership.count({ where }),
      resolveTotalSupply(key.id, key.circulatingSupply),
   ]);

   return {
      keyId: key.id,
      totalSupply,
      totalHolders,
      items: rows.map((row, i) => toEntry(row, i + 1, totalSupply)),
      computedAt: new Date().toISOString(),
   };
}

/**
 * Recompute the top-N leaderboard for a key and overwrite the cache entry
 * (resetting its 5-minute TTL). Called on every trade/transfer event and on
 * a cache miss.
 */
export async function refreshHolderLeaderboard(
   keyIdOrHandle: string
): Promise<HolderLeaderboardSnapshot> {
   const key = await resolveKey(keyIdOrHandle);
   const snapshot = await computeSnapshot(key);
   await cacheSetJson(
      holderLeaderboardCacheKey(key.id),
      snapshot,
      HOLDER_LEADERBOARD_CACHE_TTL_SECONDS
   );
   return snapshot;
}

/**
 * Event hook for balance-changing trade and transfer events. Must be called
 * AFTER the balance change is committed. Never throws: a failed refresh drops
 * the cache entry so the next read recomputes, and never fails the trade.
 */
export async function onHolderBalanceChanged(
   ...creatorIds: string[]
): Promise<void> {
   const unique = Array.from(new Set(creatorIds.filter(Boolean)));
   for (const creatorId of unique) {
      try {
         await refreshHolderLeaderboard(creatorId);
      } catch (error) {
         logger.warn(
            { error, creatorId },
            'Holder leaderboard refresh failed; invalidating cache'
         );
         try {
            await cacheInvalidate(holderLeaderboardCacheKey(creatorId));
         } catch {
            // best-effort only
         }
      }
   }
}

async function getSnapshot(key: ResolvedKey): Promise<HolderLeaderboardSnapshot> {
   const cached = await cacheGetJson<HolderLeaderboardSnapshot>(
      holderLeaderboardCacheKey(key.id)
   );
   if (cached) return cached;

   const snapshot = await computeSnapshot(key);
   await cacheSetJson(
      holderLeaderboardCacheKey(key.id),
      snapshot,
      HOLDER_LEADERBOARD_CACHE_TTL_SECONDS
   );
   return snapshot;
}

// ── Cursor ──────────────────────────────────────────────────────────────────

interface HolderCursorPayload {
   b: string; // balance of the last item on the previous page
   c: string; // createdAt (ISO) of the last item
   a: string; // ownerAddress of the last item
}

function encodeHolderCursor(row: {
   ownerAddress: string;
   balance: unknown;
   createdAt: Date;
}): string {
   return encodeCursor<HolderCursorPayload>({
      b: String(row.balance),
      c: row.createdAt.toISOString(),
      a: row.ownerAddress,
   });
}

function decodeHolderCursor(raw: string): {
   balance: string;
   createdAt: Date;
   ownerAddress: string;
} {
   try {
      const p = decodeCursor<HolderCursorPayload>(raw);
      const createdAt = new Date(p.c);
      if (
         typeof p.b !== 'string' ||
         typeof p.a !== 'string' ||
         !p.a ||
         Number.isNaN(createdAt.getTime()) ||
         !/^\d+(\.\d+)?$/.test(p.b)
      ) {
         throw new InvalidHolderCursorError();
      }
      return { balance: p.b, createdAt, ownerAddress: p.a };
   } catch {
      throw new InvalidHolderCursorError();
   }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Leaderboard page.
 *
 * - No cursor: served from the 5-minute cache (top 100), sliced to `limit`.
 * - With cursor: keyset pagination straight from the database, resuming
 *   strictly after the cursor's (balance, createdAt, wallet) position, so it
 *   stays stable while balances change between requests.
 */
export async function getHolderLeaderboard(
   keyIdOrHandle: string,
   opts: { limit?: number; cursor?: string } = {}
): Promise<HolderLeaderboardPage> {
   const limit = Math.min(
      Math.max(opts.limit ?? HOLDER_LEADERBOARD_TOP_N, 1),
      MAX_PAGE_SIZE
   );
   const key = await resolveKey(keyIdOrHandle);

   if (!opts.cursor) {
      const snapshot = await getSnapshot(key);
      const items = snapshot.items.slice(0, limit);
      const hasMore = snapshot.totalHolders > items.length;
      const last = items[items.length - 1];
      return {
         keyId: key.id,
         totalSupply: snapshot.totalSupply,
         totalHolders: snapshot.totalHolders,
         items,
         hasMore,
         nextCursor:
            hasMore && last
               ? encodeHolderCursor({
                    ownerAddress: last.wallet_address,
                    balance: last.balance,
                    createdAt: new Date(last.since),
                 })
               : null,
      };
   }

   const cursor = decodeHolderCursor(opts.cursor);
   const where: Prisma.KeyOwnershipWhereInput = {
      creatorId: key.id,
      balance: { gt: 0 },
      OR: behind(cursor.balance, cursor.createdAt, cursor.ownerAddress),
   };
   const baseWhere: Prisma.KeyOwnershipWhereInput = {
      creatorId: key.id,
      balance: { gt: 0 },
   };

   const [rows, totalHolders, totalSupply, aheadCount] = await Promise.all([
      prisma.keyOwnership.findMany({
         where,
         orderBy: ORDER_BY,
         take: limit + 1,
         select: { ownerAddress: true, balance: true, createdAt: true },
      }),
      prisma.keyOwnership.count({ where: baseWhere }),
      resolveTotalSupply(key.id, key.circulatingSupply),
      // Holders at or ahead of the cursor position (the cursor row itself
      // is included only if it still exists with the same values).
      prisma.keyOwnership.count({
         where: {
            ...baseWhere,
            OR: [
               ...aheadOf(cursor.balance, cursor.createdAt, cursor.ownerAddress),
               {
                  balance: cursor.balance as unknown as Prisma.Decimal,
                  createdAt: cursor.createdAt,
                  ownerAddress: cursor.ownerAddress,
               },
            ],
         },
      }),
   ]);

   const hasMore = rows.length > limit;
   const page = hasMore ? rows.slice(0, limit) : rows;
   const startRank = aheadCount + 1;

   return {
      keyId: key.id,
      totalSupply,
      totalHolders,
      items: page.map((row, i) => toEntry(row, startRank + i, totalSupply)),
      hasMore,
      nextCursor:
         hasMore && page.length > 0
            ? encodeHolderCursor(page[page.length - 1])
            : null,
   };
}

/**
 * Rank, balance and supply share of a single wallet. Uses a COUNT of holders
 * strictly ahead under the leaderboard's own ordering instead of loading the
 * list, so it always agrees with the leaderboard.
 */
export async function getHolderRank(
   keyIdOrHandle: string,
   wallet: string
): Promise<HolderRank> {
   const key = await resolveKey(keyIdOrHandle);

   const holder = await prisma.keyOwnership.findUnique({
      where: {
         ownerAddress_creatorId: { ownerAddress: wallet, creatorId: key.id },
      },
      select: { ownerAddress: true, balance: true, createdAt: true },
   });
   if (!holder || Number(holder.balance) <= 0) {
      throw new HolderNotFoundError(wallet);
   }

   const baseWhere: Prisma.KeyOwnershipWhereInput = {
      creatorId: key.id,
      balance: { gt: 0 },
   };

   const [aheadCount, totalHolders, totalSupply] = await Promise.all([
      prisma.keyOwnership.count({
         where: {
            ...baseWhere,
            OR: aheadOf(holder.balance, holder.createdAt, holder.ownerAddress),
         },
      }),
      prisma.keyOwnership.count({ where: baseWhere }),
      resolveTotalSupply(key.id, key.circulatingSupply),
   ]);

   const entry = toEntry(holder, aheadCount + 1, totalSupply);
   return {
      keyId: key.id,
      wallet_address: entry.wallet_address,
      rank: entry.rank,
      balance: entry.balance,
      supply_percent: entry.supply_percent,
      since: entry.since,
      totalHolders,
   };
}
