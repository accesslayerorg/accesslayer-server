import { prisma } from '../utils/prisma.utils';
import { getRedis } from '../utils/redis.utils';

export const DEFAULT_RELATED_KEYS_LIMIT = 8;
export const MAX_RELATED_KEYS_LIMIT = 20;
export const RELATED_KEYS_CACHE_TTL_SECONDS = 15 * 60;

export interface RelatedKeyResult {
   keyId: string;
   score: number;
}

interface RelatedKeyRow {
   keyId?: unknown;
   key_id?: unknown;
   id?: unknown;
   score?: unknown;
   isFrozen?: unknown;
   is_frozen?: unknown;
   frozen?: unknown;
   isRetired?: unknown;
   is_retired?: unknown;
   retired?: unknown;
   isDeprecated?: unknown;
   deprecated?: unknown;
   deprecatedAt?: unknown;
   deprecated_at?: unknown;
   status?: unknown;
}

const RELATED_KEYS_SQL = `WITH holdings AS (
   SELECT "ownerAddress", "creatorId", balance
   FROM "KeyOwnership"
   WHERE balance > 0
)
SELECT
   holdings."creatorId" AS "keyId",
   SUM(LEAST(source.balance::numeric, holdings.balance::numeric))::float8 AS score,
   (
      COALESCE((to_jsonb(cp) ->> 'isFrozen')::boolean, false)
      OR COALESCE((to_jsonb(cp) ->> 'frozen')::boolean, false)
   ) AS "isFrozen",
   (
      COALESCE((to_jsonb(cp) ->> 'isRetired')::boolean, false)
      OR COALESCE((to_jsonb(cp) ->> 'retired')::boolean, false)
   ) AS "isRetired",
   (to_jsonb(cp) ->> 'deprecatedAt') IS NOT NULL AS "isDeprecated",
   COALESCE(to_jsonb(cp) ->> 'status', '') AS status
FROM holdings
JOIN holdings AS source
   ON source."ownerAddress" = holdings."ownerAddress"
  AND source."creatorId" = $1
JOIN "CreatorProfile" AS cp
   ON cp.id = holdings."creatorId"
WHERE holdings."creatorId" <> $1
GROUP BY holdings."creatorId", cp.id
ORDER BY score DESC, "keyId" ASC
LIMIT $3`;

function toNumber(value: unknown): number {
   if (typeof value === 'number') {
      return Number.isFinite(value) ? value : 0;
   }
   if (
      value &&
      typeof value === 'object' &&
      'toNumber' in value &&
      typeof (value as { toNumber: unknown }).toNumber === 'function'
   ) {
      const converted = (value as { toNumber: () => unknown }).toNumber();
      const numeric = Number(converted);
      return Number.isFinite(numeric) ? numeric : 0;
   }
   const numeric = Number(value);
   return Number.isFinite(numeric) ? numeric : 0;
}

function isTruthyFlag(value: unknown): boolean {
   if (value === true || value === 1 || value === '1') return true;
   if (typeof value === 'string') {
      return value.trim().toLowerCase() === 'true';
   }
   return false;
}

function isExcludedRow(row: RelatedKeyRow, sourceKeyId: string): boolean {
   const keyId = readKeyId(row);
   if (!keyId || keyId === sourceKeyId) return true;

   const status =
      typeof row.status === 'string' ? row.status.toLowerCase() : '';
   return (
      isTruthyFlag(row.isFrozen) ||
      isTruthyFlag(row.is_frozen) ||
      isTruthyFlag(row.frozen) ||
      isTruthyFlag(row.isRetired) ||
      isTruthyFlag(row.is_retired) ||
      isTruthyFlag(row.retired) ||
      isTruthyFlag(row.isDeprecated) ||
      isTruthyFlag(row.deprecated) ||
      (row.deprecatedAt !== null && row.deprecatedAt !== undefined) ||
      (row.deprecated_at !== null && row.deprecated_at !== undefined) ||
      status === 'frozen' ||
      status === 'retired' ||
      status === 'deprecated' ||
      status === 'inactive'
   );
}

function readKeyId(row: RelatedKeyRow): string | null {
   const value = row.keyId ?? row.key_id ?? row.id;
   if (typeof value !== 'string' && typeof value !== 'number') return null;
   const keyId = String(value).trim();
   return keyId.length > 0 ? keyId : null;
}

function normalizeRow(
   row: RelatedKeyRow,
   sourceKeyId: string
): RelatedKeyResult | null {
   if (isExcludedRow(row, sourceKeyId)) return null;
   const keyId = readKeyId(row);
   if (!keyId) return null;
   return { keyId, score: toNumber(row.score) };
}

function normalizeRows(
   rows: RelatedKeyRow[],
   sourceKeyId: string
): RelatedKeyResult[] {
   return rows
      .map(row => normalizeRow(row, sourceKeyId))
      .filter((row): row is RelatedKeyResult => row !== null)
      .sort((a, b) => b.score - a.score || a.keyId.localeCompare(b.keyId));
}

export function normalizeRelatedKeysLimit(value: unknown): number {
   if (value === undefined || value === null || value === '') {
      return DEFAULT_RELATED_KEYS_LIMIT;
   }
   const parsed = Number(value);
   if (!Number.isInteger(parsed) || parsed < 1) {
      return DEFAULT_RELATED_KEYS_LIMIT;
   }
   return Math.min(parsed, MAX_RELATED_KEYS_LIMIT);
}

function getCacheKey(keyId: string): string {
   return `related:${keyId}`;
}

type CacheClient = {
   status?: string;
   get?: (key: string) => Promise<unknown>;
   setex?: (key: string, seconds: number, value: string) => Promise<unknown>;
   set?: (
      key: string,
      value: string,
      mode: string,
      ttl: number
   ) => Promise<unknown>;
};

function getUsableCacheClient(): CacheClient | null {
   try {
      const client = getRedis() as unknown as CacheClient;
      if (!client || typeof client.get !== 'function') return null;
      if (client.status && client.status !== 'ready') return null;
      return client;
   } catch {
      return null;
   }
}

async function readCachedResults(
   keyId: string,
   sourceKeyId: string
): Promise<RelatedKeyResult[] | null> {
   const client = getUsableCacheClient();
   if (!client || typeof client.get !== 'function') return null;
   try {
      const raw = await client.get(getCacheKey(keyId));
      if (typeof raw !== 'string' || raw.length === 0) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      return normalizeRows(parsed as RelatedKeyRow[], sourceKeyId);
   } catch {
      return null;
   }
}

async function writeCachedResults(
   keyId: string,
   results: RelatedKeyResult[]
): Promise<void> {
   const client = getUsableCacheClient();
   if (!client) return;
   const cacheKey = getCacheKey(keyId);
   const payload = JSON.stringify(results);
   try {
      if (typeof client.setex === 'function') {
         await client.setex(cacheKey, RELATED_KEYS_CACHE_TTL_SECONDS, payload);
      } else if (typeof client.set === 'function') {
         await client.set(
            cacheKey,
            payload,
            'EX',
            RELATED_KEYS_CACHE_TTL_SECONDS
         );
      }
   } catch {
      return;
   }
}

async function queryRelatedKeys(
   keyId: string,
   limit: number
): Promise<RelatedKeyRow[]> {
   const client = prisma as unknown as {
      $queryRaw?: (
         strings: TemplateStringsArray,
         ...values: unknown[]
      ) => Promise<RelatedKeyRow[]>;
      $queryRawUnsafe?: (
         query: string,
         ...values: unknown[]
      ) => Promise<RelatedKeyRow[]>;
   };

   if (typeof client.$queryRaw === 'function') {
      return client.$queryRaw`
         WITH holdings AS (
            SELECT "ownerAddress", "creatorId", balance
            FROM "KeyOwnership"
            WHERE balance > 0
         )
         SELECT
            holdings."creatorId" AS "keyId",
            SUM(LEAST(source.balance::numeric, holdings.balance::numeric))::float8 AS score,
            (
               COALESCE((to_jsonb(cp) ->> 'isFrozen')::boolean, false)
               OR COALESCE((to_jsonb(cp) ->> 'frozen')::boolean, false)
            ) AS "isFrozen",
            (
               COALESCE((to_jsonb(cp) ->> 'isRetired')::boolean, false)
               OR COALESCE((to_jsonb(cp) ->> 'retired')::boolean, false)
            ) AS "isRetired",
            (to_jsonb(cp) ->> 'deprecatedAt') IS NOT NULL AS "isDeprecated",
            COALESCE(to_jsonb(cp) ->> 'status', '') AS status
         FROM holdings
         JOIN holdings AS source
            ON source."ownerAddress" = holdings."ownerAddress"
           AND source."creatorId" = ${keyId}
         JOIN "CreatorProfile" AS cp
            ON cp.id = holdings."creatorId"
         WHERE holdings."creatorId" <> ${keyId}
         GROUP BY holdings."creatorId", cp.id
         ORDER BY score DESC, "keyId" ASC
         LIMIT ${limit}
      `;
   }

   if (typeof client.$queryRawUnsafe === 'function') {
      return client.$queryRawUnsafe(RELATED_KEYS_SQL, keyId, keyId, limit);
   }

   return [];
}

export class RelatedKeysService {
   static async find(
      keyId: string,
      limit: number = DEFAULT_RELATED_KEYS_LIMIT
   ): Promise<RelatedKeyResult[]> {
      const sourceKeyId = typeof keyId === 'string' ? keyId.trim() : '';
      if (!sourceKeyId) return [];

      const effectiveLimit = normalizeRelatedKeysLimit(limit);
      const cached = await readCachedResults(sourceKeyId, sourceKeyId);
      if (cached !== null) return cached.slice(0, effectiveLimit);

      const rows = await queryRelatedKeys(sourceKeyId, effectiveLimit);
      const results = normalizeRows(rows, sourceKeyId).slice(0, effectiveLimit);
      await writeCachedResults(sourceKeyId, results);
      return results;
   }

   async find(
      keyId: string,
      limit: number = DEFAULT_RELATED_KEYS_LIMIT
   ): Promise<RelatedKeyResult[]> {
      return RelatedKeysService.find(keyId, limit);
   }
}

export const findRelatedKeys = (
   keyId: string,
   limit: number = DEFAULT_RELATED_KEYS_LIMIT
): Promise<RelatedKeyResult[]> => RelatedKeysService.find(keyId, limit);

export default RelatedKeysService;
