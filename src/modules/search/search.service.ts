// src/modules/search/search.service.ts
/**
 * Global search across creator keys, creator profiles and transaction hashes
 * (#1010).
 *
 * - Keys match on on-chain metadata: name, symbol and description.
 * - Creators match on display name and wallet-address prefix.
 * - Transactions match on an exact tx hash only.
 *
 * Key and creator results are relevance-ranked in SQL so the grouped overlay
 * response returns genuinely the best matches, and the same ranking powers the
 * keyset cursor used by the full results endpoints.
 */

import { prisma } from '../../utils/prisma.utils';
import { decodeCursor, encodeCursor } from '../../utils/cursor.utils';
import {
   SEARCH_GROUP_LIMITS,
   SEARCH_MIN_QUERY_LENGTH,
} from './search.constants';

// ── Public result shapes ──────────────────────────────────────────────────────

export interface SearchKeyResult {
   keyId: string;
   keyAddress: string | null;
   name: string;
   symbol: string;
   description: string | null;
   imageUrl: string | null;
   creatorName: string | null;
   creatorHandle: string | null;
   creatorAvatarUrl: string | null;
   currentPrice: string | null;
   holderCount: number;
   deprecated: boolean;
}

export interface SearchCreatorResult {
   id: string;
   handle: string;
   displayName: string;
   bio: string | null;
   avatarUrl: string | null;
   isVerified: boolean;
   walletAddress: string | null;
   followersCount: number;
}

export type SearchTransactionSource = 'contract' | 'trade';

export interface SearchTransactionResult {
   txHash: string;
   source: SearchTransactionSource;
   /** Contract operation (buy/sell/...) or `trade` for indexed trades. */
   operation: string;
   status: string | null;
   creatorId: string | null;
   wallet: string | null;
   ledger: number | null;
   timestamp: string | null;
}

export interface SearchPage<T> {
   items: T[];
   nextCursor: string | null;
   hasMore: boolean;
   limit: number;
}

export interface GroupedSearchResponse {
   query: string;
   keys: SearchKeyResult[];
   creators: SearchCreatorResult[];
   transactions: SearchTransactionResult[];
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class SearchQueryTooShortError extends Error {
   constructor() {
      super(`Query must be at least ${SEARCH_MIN_QUERY_LENGTH} characters`);
      this.name = 'SearchQueryTooShortError';
   }
}

export class InvalidSearchCursorError extends Error {
   constructor() {
      super('Invalid search pagination cursor');
      this.name = 'InvalidSearchCursorError';
   }
}

// ── Cursor payloads ───────────────────────────────────────────────────────────

/** Composite keyset cursor for keys: (priority, name, keyId). */
export interface KeySearchCursor {
   priority: number;
   name: string;
   keyId: string;
}

/** Composite keyset cursor for creators: (priority, displayName, id). */
export interface CreatorSearchCursor {
   priority: number;
   displayName: string;
   id: string;
}

// ── Raw row shapes ────────────────────────────────────────────────────────────

interface KeySearchRow {
   keyId: string;
   keyAddress: string | null;
   name: string;
   symbol: string;
   description: string | null;
   imageUrl: string | null;
   creatorName: string | null;
   creatorHandle: string | null;
   creatorAvatarUrl: string | null;
   currentPrice: bigint | number | string | null;
   holderCount: number | bigint | string;
   deprecatedAt: Date | string | null;
   priority: number;
}

interface CreatorSearchRow {
   id: string;
   handle: string;
   displayName: string;
   bio: string | null;
   avatarUrl: string | null;
   isVerified: boolean;
   walletAddress: string | null;
   followersCount: number;
   priority: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Builds ILIKE patterns with wildcard characters escaped, so a query
 * containing `%`, `_` or `\` is matched literally instead of acting as a
 * wildcard.
 */
function buildLikePatterns(query: string): {
   contains: string;
   prefix: string;
} {
   const escaped = query
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');
   return {
      contains: `%${escaped}%`,
      prefix: `${escaped}%`,
   };
}

function requireSearchableQuery(query: string): string {
   const trimmed = query.trim();
   if (trimmed.length < SEARCH_MIN_QUERY_LENGTH) {
      throw new SearchQueryTooShortError();
   }
   return trimmed;
}

function toNullableString(
   value: bigint | number | string | null | undefined
): string | null {
   if (value === null || value === undefined) return null;
   return value.toString();
}

function decodeKeyCursor(raw: string): KeySearchCursor {
   try {
      const payload = decodeCursor<KeySearchCursor>(raw);
      if (
         !Number.isInteger(payload.priority) ||
         typeof payload.name !== 'string' ||
         typeof payload.keyId !== 'string' ||
         payload.keyId.length === 0
      ) {
         throw new InvalidSearchCursorError();
      }
      return payload;
   } catch {
      throw new InvalidSearchCursorError();
   }
}

function decodeCreatorCursor(raw: string): CreatorSearchCursor {
   try {
      const payload = decodeCursor<CreatorSearchCursor>(raw);
      if (
         !Number.isInteger(payload.priority) ||
         typeof payload.displayName !== 'string' ||
         typeof payload.id !== 'string' ||
         payload.id.length === 0
      ) {
         throw new InvalidSearchCursorError();
      }
      return payload;
   } catch {
      throw new InvalidSearchCursorError();
   }
}

function mapKeyRow(row: KeySearchRow): SearchKeyResult {
   return {
      keyId: row.keyId,
      keyAddress: row.keyAddress,
      name: row.name,
      symbol: row.symbol,
      description: row.description,
      imageUrl: row.imageUrl,
      creatorName: row.creatorName,
      creatorHandle: row.creatorHandle,
      creatorAvatarUrl: row.creatorAvatarUrl,
      currentPrice: toNullableString(row.currentPrice),
      holderCount: Number(row.holderCount ?? 0),
      deprecated: row.deprecatedAt !== null && row.deprecatedAt !== undefined,
   };
}

function mapCreatorRow(row: CreatorSearchRow): SearchCreatorResult {
   return {
      id: row.id,
      handle: row.handle,
      displayName: row.displayName,
      bio: row.bio,
      avatarUrl: row.avatarUrl,
      isVerified: Boolean(row.isVerified),
      walletAddress: row.walletAddress,
      followersCount: Number(row.followersCount ?? 0),
   };
}

// ── Keys ──────────────────────────────────────────────────────────────────────

/**
 * Searches creator keys by on-chain metadata (name, symbol, description).
 *
 * Rank order: exact name, exact symbol, name prefix, symbol prefix, name or
 * symbol substring, then description-only matches. Ties break deterministically
 * on (name, keyId) so the keyset cursor is stable.
 */
export async function searchKeys(
   query: string,
   options: { limit: number; cursor?: string }
): Promise<SearchPage<SearchKeyResult>> {
   const q = requireSearchableQuery(query);
   const { contains, prefix } = buildLikePatterns(q);
   const cursor = options.cursor ? decodeKeyCursor(options.cursor) : null;
   const take = options.limit + 1;

   const rows = await prisma.$queryRaw<KeySearchRow[]>`
      WITH matched AS (
         SELECT
            km."keyId" AS "keyId",
            km."keyAddress" AS "keyAddress",
            km."name" AS "name",
            km."symbol" AS "symbol",
            km."description" AS "description",
            km."image_url" AS "imageUrl",
            c."displayName" AS "creatorName",
            c."handle" AS "creatorHandle",
            c."avatarUrl" AS "creatorAvatarUrl",
            c."deprecatedAt" AS "deprecatedAt",
            s."currentPrice" AS "currentPrice",
            (
               SELECT COUNT(*)::int
               FROM "KeyOwnership" ko
               WHERE ko."creatorId" = km."keyId"
                 AND ko."balance" > 0
            ) AS "holderCount",
            CASE
               WHEN lower(km."name") = lower(${q}) THEN 0
               WHEN lower(km."symbol") = lower(${q}) THEN 1
               WHEN km."name" ILIKE ${prefix} THEN 2
               WHEN km."symbol" ILIKE ${prefix} THEN 3
               WHEN km."name" ILIKE ${contains}
                 OR km."symbol" ILIKE ${contains} THEN 4
               ELSE 5
            END AS priority
         FROM "key_metadata" km
         LEFT JOIN "CreatorProfile" c ON c."id" = km."keyId"
         LEFT JOIN "creator_price_snapshots" s ON s."creatorId" = c."id"
         WHERE km."name" ILIKE ${contains}
            OR km."symbol" ILIKE ${contains}
            OR km."description" ILIKE ${contains}
      )
      SELECT *
      FROM matched
      WHERE (
         ${cursor?.priority ?? null}::int IS NULL
         OR (priority, "name", "keyId") > (
            ${cursor?.priority ?? null}::int,
            ${cursor?.name ?? null}::text,
            ${cursor?.keyId ?? null}::text
         )
      )
      ORDER BY priority ASC, "name" ASC, "keyId" ASC
      LIMIT ${take}
   `;

   const hasMore = rows.length > options.limit;
   const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
   const lastRow = pageRows[pageRows.length - 1];

   return {
      items: pageRows.map(mapKeyRow),
      nextCursor:
         hasMore && lastRow
            ? encodeCursor<KeySearchCursor>({
                 priority: lastRow.priority,
                 name: lastRow.name,
                 keyId: lastRow.keyId,
              })
            : null,
      hasMore,
      limit: options.limit,
   };
}

// ── Creators ──────────────────────────────────────────────────────────────────

/**
 * Searches creator profiles by display name and wallet-address prefix.
 *
 * Rank order: exact display name, exact wallet address, display-name prefix,
 * wallet-address prefix, then display-name substring. Wallet matching is
 * always a prefix match, per the search-overlay contract.
 */
export async function searchCreators(
   query: string,
   options: { limit: number; cursor?: string }
): Promise<SearchPage<SearchCreatorResult>> {
   const q = requireSearchableQuery(query);
   const { contains, prefix } = buildLikePatterns(q);
   const cursor = options.cursor ? decodeCreatorCursor(options.cursor) : null;
   const take = options.limit + 1;

   const rows = await prisma.$queryRaw<CreatorSearchRow[]>`
      WITH matched AS (
         SELECT
            c."id" AS "id",
            c."handle" AS "handle",
            c."displayName" AS "displayName",
            c."bio" AS "bio",
            c."avatarUrl" AS "avatarUrl",
            c."isVerified" AS "isVerified",
            c."followersCount" AS "followersCount",
            w."address" AS "walletAddress",
            CASE
               WHEN lower(c."displayName") = lower(${q}) THEN 0
               WHEN lower(w."address") = lower(${q}) THEN 1
               WHEN c."displayName" ILIKE ${prefix} THEN 2
               WHEN w."address" ILIKE ${prefix} THEN 3
               ELSE 4
            END AS priority
         FROM "CreatorProfile" c
         LEFT JOIN "User" u ON u."id" = c."userId"
         LEFT JOIN "StellarWallet" w ON w."userId" = u."id"
         WHERE c."displayName" ILIKE ${contains}
            OR w."address" ILIKE ${prefix}
      )
      SELECT *
      FROM matched
      WHERE (
         ${cursor?.priority ?? null}::int IS NULL
         OR (priority, "displayName", "id") > (
            ${cursor?.priority ?? null}::int,
            ${cursor?.displayName ?? null}::text,
            ${cursor?.id ?? null}::text
         )
      )
      ORDER BY priority ASC, "displayName" ASC, "id" ASC
      LIMIT ${take}
   `;

   const hasMore = rows.length > options.limit;
   const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
   const lastRow = pageRows[pageRows.length - 1];

   return {
      items: pageRows.map(mapCreatorRow),
      nextCursor:
         hasMore && lastRow
            ? encodeCursor<CreatorSearchCursor>({
                 priority: lastRow.priority,
                 displayName: lastRow.displayName,
                 id: lastRow.id,
              })
            : null,
      hasMore,
      limit: options.limit,
   };
}

// ── Transactions ──────────────────────────────────────────────────────────────

/**
 * Looks up a transaction by exact tx hash.
 *
 * Contract-service transactions are checked first (they carry operation and
 * status), then indexed trades. No prefix or substring matching is performed.
 */
export async function searchTransaction(
   query: string
): Promise<SearchTransactionResult | null> {
   const txHash = query.trim();
   if (!txHash) return null;

   const contractTransaction = await prisma.contractTransaction.findUnique({
      where: { txHash },
      select: {
         txHash: true,
         operation: true,
         status: true,
         submitterWallet: true,
         ledger: true,
         createdAt: true,
      },
   });

   if (contractTransaction) {
      return {
         txHash: contractTransaction.txHash,
         source: 'contract',
         operation: contractTransaction.operation,
         status: contractTransaction.status,
         creatorId: null,
         wallet: contractTransaction.submitterWallet,
         ledger: contractTransaction.ledger,
         timestamp: contractTransaction.createdAt.toISOString(),
      };
   }

   const trade = await prisma.trade.findFirst({
      where: { txHash },
      orderBy: { createdAt: 'desc' },
      select: {
         txHash: true,
         creatorId: true,
         buyer: true,
         ledger: true,
         timestamp: true,
      },
   });

   if (trade) {
      return {
         txHash: trade.txHash,
         source: 'trade',
         operation: 'trade',
         status: null,
         creatorId: trade.creatorId,
         wallet: trade.buyer,
         ledger: trade.ledger,
         timestamp: trade.timestamp.toISOString(),
      };
   }

   return null;
}

// ── Grouped overlay search ────────────────────────────────────────────────────

/**
 * Grouped search used by the client search overlay: the top three keys, the
 * top three creators and the single exact tx-hash match.
 */
export async function getGroupedSearch(
   query: string
): Promise<GroupedSearchResponse> {
   const q = requireSearchableQuery(query);

   const [keys, creators, transaction] = await Promise.all([
      searchKeys(q, { limit: SEARCH_GROUP_LIMITS.keys }),
      searchCreators(q, { limit: SEARCH_GROUP_LIMITS.creators }),
      searchTransaction(q),
   ]);

   return {
      query: q,
      keys: keys.items,
      creators: creators.items,
      transactions: transaction ? [transaction] : [],
   };
}
