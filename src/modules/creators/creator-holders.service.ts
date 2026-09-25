import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { CreatorHoldersQueryType } from './creator-holders.schemas';
import {
   encodeCursor,
   decodeCursor,
   CursorChecksumError,
} from '../../utils/cursor.utils';

/**
 * Public-facing holder record returned by the holders endpoint.
 */
export interface HolderRecord {
   wallet_address: string;
   key_balance: number;
   held_since: Date;
   /** Alias of key_balance kept for response-shape compatibility. */
   key_count: number;
   /** This wallet's share of all outstanding keys for the creator, 0-100. */
   share_percent: number;
   /** 1-based position in the full (offset-aware) sorted holder list. */
   rank: number;
}

/**
 * Look up a creator profile by cuid id or handle.
 * Returns null if no creator matches either field.
 */
export async function findCreatorByIdOrHandle(
   idOrHandle: string
): Promise<{ id: string; handle: string } | null> {
   return prisma.creatorProfile.findFirst({
      where: {
         OR: [{ id: idOrHandle }, { handle: idOrHandle }],
      },
      select: { id: true, handle: true },
   });
}

/**
 * Fetch a paginated, sorted list of key holders for a creator.
 *
 * - Default sort: largest balance first (key_balance desc)
 * - sort=held_since: earliest buyer first (createdAt asc)
 * - Only returns records with balance > 0 (excludes wallets that sold all keys)
 * - held_since is derived from KeyOwnership.createdAt, which is set when the
 *   ownership row is first created (i.e. the wallet's first buy for this creator)
 *
 * @param creatorId - The creator's cuid from CreatorProfile
 * @param query     - Validated query params (limit, offset, sort)
 * @returns Tuple of [holder records, total count]
 */
export async function fetchCreatorHolders(
   creatorId: string,
   query: CreatorHoldersQueryType
): Promise<[HolderRecord[], number]> {
   const { limit, offset, sort } = query;
   const startMs = Date.now();

   const where: Prisma.KeyOwnershipWhereInput = {
      creatorId,
      balance: { gt: 0 },
   };

   // Tie-break alphabetically by wallet address so results are deterministic
   // when two holders have the same balance.
   const orderBy: Prisma.KeyOwnershipOrderByWithRelationInput[] =
      sort === 'held_since'
         ? [{ createdAt: 'asc' }, { ownerAddress: 'asc' }]
         : [{ balance: 'desc' }, { ownerAddress: 'asc' }];

   const [rows, total, balanceSum] = await Promise.all([
      prisma.keyOwnership.findMany({
         where,
         orderBy,
         skip: offset,
         take: limit,
         select: {
            ownerAddress: true,
            balance: true,
            createdAt: true,
         },
      }),
      prisma.keyOwnership.count({ where }),
      prisma.keyOwnership.aggregate({ where, _sum: { balance: true } }),
   ]);

   const totalKeys = Number(balanceSum._sum.balance ?? 0);

   const holders: HolderRecord[] = rows.map((row, index) => {
      const keyBalance = Number(row.balance);
      return {
         wallet_address: row.ownerAddress,
         key_balance: keyBalance,
         held_since: row.createdAt,
         key_count: keyBalance,
         share_percent: totalKeys > 0 ? (keyBalance / totalKeys) * 100 : 0,
         rank: offset + index + 1,
      };
   });

   if (holders.length === 0) {
      const durationMs = Date.now() - startMs;
      logger.debug(
         {
            creator_id: creatorId,
            holder_count: 0,
            query_duration_ms: durationMs,
         },
         'Creator holders query returned zero results'
      );
   }

   return [holders, total];
}

/** Cursor payload for keyset-paginated holder pages. */
interface HoldersCursorPayload {
   ownerAddress: string;
}

/**
 * Encodes a holder's wallet address into an opaque, tamper-checked cursor
 * string suitable for the `nextCursor` response field.
 */
export function encodeHoldersCursor(ownerAddress: string): string {
   return encodeCursor<HoldersCursorPayload>({ ownerAddress });
}

export type DecodeHoldersCursorResult =
   | { ok: true; ownerAddress: string }
   | { ok: false };

/**
 * Decodes and validates a client-supplied holders cursor.
 * Returns `{ ok: false }` for malformed, tampered, or empty cursors.
 */
export function decodeHoldersCursor(raw: string): DecodeHoldersCursorResult {
   try {
      const payload = decodeCursor<HoldersCursorPayload>(raw);
      if (typeof payload.ownerAddress !== 'string' || !payload.ownerAddress) {
         return { ok: false };
      }
      return { ok: true, ownerAddress: payload.ownerAddress };
   } catch (error) {
      if (error instanceof CursorChecksumError) {
         return { ok: false };
      }
      return { ok: false };
   }
}

export interface CursorHolderPage {
   holders: HolderRecord[];
   nextCursor: string | null;
   hasMore: boolean;
}

/**
 * Fetch a keyset-paginated page of key holders for a creator, resuming after
 * the holder identified by `cursorOwnerAddress`.
 *
 * Uses the (ownerAddress, creatorId) unique index as the Prisma cursor so
 * pagination stays stable and index-backed even as new holders are added.
 * Over-fetches by one row to determine `hasMore` without a separate count
 * query.
 *
 * @returns `null` if `cursorOwnerAddress` does not identify an existing
 *          holder row for this creator (i.e. the cursor is stale/invalid).
 */
export async function fetchCreatorHoldersByCursor(
   creatorId: string,
   query: CreatorHoldersQueryType,
   cursorOwnerAddress: string
): Promise<CursorHolderPage | null> {
   const { limit, sort } = query;

   const where: Prisma.KeyOwnershipWhereInput = {
      creatorId,
      balance: { gt: 0 },
   };

   const orderBy: Prisma.KeyOwnershipOrderByWithRelationInput[] =
      sort === 'held_since'
         ? [{ createdAt: 'asc' }, { ownerAddress: 'asc' }]
         : [{ balance: 'desc' }, { ownerAddress: 'asc' }];

   const cursorRow = await prisma.keyOwnership.findUnique({
      where: {
         ownerAddress_creatorId: {
            ownerAddress: cursorOwnerAddress,
            creatorId,
         },
      },
      select: { id: true },
   });

   if (!cursorRow) {
      return null;
   }

   const [rows, balanceSum] = await Promise.all([
      prisma.keyOwnership.findMany({
         where,
         orderBy,
         cursor: {
            ownerAddress_creatorId: {
               ownerAddress: cursorOwnerAddress,
               creatorId,
            },
         },
         skip: 1,
         take: limit + 1,
         select: {
            ownerAddress: true,
            balance: true,
            createdAt: true,
         },
      }),
      prisma.keyOwnership.aggregate({ where, _sum: { balance: true } }),
   ]);

   const totalKeys = Number(balanceSum._sum.balance ?? 0);
   const hasMore = rows.length > limit;
   const page = hasMore ? rows.slice(0, limit) : rows;

   const holders: HolderRecord[] = page.map((row, index) => {
      const keyBalance = Number(row.balance);
      return {
         wallet_address: row.ownerAddress,
         key_balance: keyBalance,
         held_since: row.createdAt,
         key_count: keyBalance,
         share_percent: totalKeys > 0 ? (keyBalance / totalKeys) * 100 : 0,
         // Position within this page only — cursor pagination doesn't track
         // an absolute offset across pages.
         rank: index + 1,
      };
   });

   const nextCursor =
      hasMore && page.length > 0
         ? encodeHoldersCursor(page[page.length - 1].ownerAddress)
         : null;

   return { holders, nextCursor, hasMore };
}
