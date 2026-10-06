// src/modules/keys/key-search.service.ts
import { prisma } from '../../utils/prisma.utils';
import {
   KEY_SEARCH_MAX_RESULTS,
   KEY_SEARCH_MIN_QUERY_LENGTH,
} from '../../constants/notifications.constants';

export type KeySearchResult = {
   keyId: string;
   creatorName: string;
   avatarUrl: string | null;
   currentPrice: string | null;
   holderCount: number;
   deprecated: boolean;
};

export class KeySearchQueryTooShortError extends Error {
   constructor() {
      super(`Query must be at least ${KEY_SEARCH_MIN_QUERY_LENGTH} characters`);
      this.name = 'KeySearchQueryTooShortError';
   }
}

type SearchRow = {
   keyId: string;
   creatorName: string;
   avatarUrl: string | null;
   currentPrice: bigint | null;
   holderCount: bigint;
   deprecatedAt: Date | null;
   rank: number;
};

/**
 * Full-text search over creator displayName (creatorName) and bio (description).
 * Results are ranked by ts_rank and capped at KEY_SEARCH_MAX_RESULTS.
 */
export async function searchKeys(query: string): Promise<KeySearchResult[]> {
   const trimmed = query.trim();
   if (trimmed.length < KEY_SEARCH_MIN_QUERY_LENGTH) {
      throw new KeySearchQueryTooShortError();
   }

   const rows = await prisma.$queryRaw<SearchRow[]>`
      SELECT
         c.id AS "keyId",
         c."displayName" AS "creatorName",
         c."avatarUrl" AS "avatarUrl",
         c."deprecatedAt" AS "deprecatedAt",
         s."currentPrice" AS "currentPrice",
         (
            SELECT COUNT(*)::bigint
            FROM "KeyOwnership" ko
            WHERE ko."creatorId" = c.id
              AND ko.balance > 0
         ) AS "holderCount",
         ts_rank(c.search_vector, plainto_tsquery('english', ${trimmed})) AS rank
      FROM "CreatorProfile" c
      LEFT JOIN "creator_price_snapshots" s ON s."creatorId" = c.id
      WHERE c.search_vector @@ plainto_tsquery('english', ${trimmed})
      ORDER BY rank DESC, c."displayName" ASC
      LIMIT ${KEY_SEARCH_MAX_RESULTS}
   `;

   return rows.map((row: SearchRow) => ({
      keyId: row.keyId,
      creatorName: row.creatorName,
      avatarUrl: row.avatarUrl,
      currentPrice:
         row.currentPrice === null || row.currentPrice === undefined
            ? null
            : row.currentPrice.toString(),
      holderCount: Number(row.holderCount),
      deprecated: row.deprecatedAt !== null,
   }));
}
