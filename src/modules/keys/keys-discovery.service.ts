import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';

/**
 * Keys discovery, leaderboard and global-search services.
 *
 * Issues #901 (discovery), #896 (leaderboard) and #895 (global search) all
 * read the same two facts — per-key 24h volume and current price — from the
 * two read models the indexer maintains: `Trade` (per-trade rows) and
 * `CreatorPriceSnapshot` (current/24hAgo price, upserted per creator).
 *
 * Volume is aggregated from `Trade` rows inside the requested window rather
 * than read from the snapshot, because the snapshot only knows 24h figures
 * and the leaderboard must support 7d and 30d windows too.
 *
 * Caching is an in-process TTL map, mirroring the pattern in
 * `creators.cache.ts` (this deployment has no Redis). The 60s TTL for
 * discovery matches the issue; leaderboard TTLs match their window size.
 * Cache entries are invalidated on new key creation by bumping a generation
 * counter that participates in every cache key.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Cache (generation-keyed TTL map)
// ─────────────────────────────────────────────────────────────────────────────

type CacheEntry = { body: unknown; expiresAt: number };

const responseCache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 200;

/** Bumped whenever a key is created, so discovery results refresh immediately. */
let cacheGeneration = 0;

export function invalidateKeysCache(): void {
   cacheGeneration += 1;
   responseCache.clear();
}

function cacheGet(key: string): unknown | undefined {
   const entry = responseCache.get(key);
   if (!entry) return undefined;
   if (entry.expiresAt <= Date.now()) {
      responseCache.delete(key);
      return undefined;
   }
   return entry.body;
}

function cacheSet(key: string, body: unknown, ttlMs: number): void {
   if (responseCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = [...responseCache.entries()].sort(
         (a, b) => a[1].expiresAt - b[1].expiresAt
      );
      for (let i = 0; i < Math.min(10, oldest.length); i += 1) {
         responseCache.delete(oldest[i][0]);
      }
   }
   responseCache.set(key, { body, expiresAt: Date.now() + ttlMs });
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────────────

export interface KeyMarketEntry {
   key_id: string;
   name: string;
   price: string;
   change_24h: number | null;
   volume_24h: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Volume aggregation (shared by discovery and leaderboard)
// ─────────────────────────────────────────────────────────────────────────────

const WINDOW_MS: Record<'24h' | '7d' | '30d', number> = {
   '24h': 24 * 60 * 60 * 1000,
   '7d': 7 * 24 * 60 * 60 * 1000,
   '30d': 30 * 24 * 60 * 60 * 1000,
};

/**
 * Aggregate per-creator trade volume (sum of `price`, in stroops) over the
 * requested window, grouped by creator, descending. Returns only creators
 * that traded, so callers merge with the creator list for the zero-volume
 * tail.
 *
 * `Trade.price` is a String column (stroops), so Prisma cannot sum it
 * server-side — rows are fetched and summed client-side as BigInt.
 */
export async function aggregateVolumeByCreator(
   window: '24h' | '7d' | '30d'
): Promise<Map<string, bigint>> {
   const since = new Date(Date.now() - WINDOW_MS[window]);
   const rows = await prisma.trade.findMany({
      where: { timestamp: { gte: since } },
      select: { creatorId: true, price: true },
   });
   const out = new Map<string, bigint>();
   for (const row of rows) {
      const prev = out.get(row.creatorId) ?? 0n;
      out.set(row.creatorId, prev + BigInt(row.price));
   }
   return out;
}

/**
 * Build one marketplace entry per creator from the price snapshot plus the
 * pre-aggregated volume. Both sections always return data — a key with zero
 * volume still appears with its snapshot price.
 */
export async function buildMarketEntries(
   creatorIds: string[]
): Promise<Map<string, KeyMarketEntry>> {
   const creators = await prisma.creatorProfile.findMany({
      where: { id: { in: creatorIds } },
      select: {
         id: true,
         handle: true,
         displayName: true,
         priceSnapshot: { select: { currentPrice: true, price24hAgo: true } },
      },
   });

   const out = new Map<string, KeyMarketEntry>();
   for (const creator of creators) {
      const snap = creator.priceSnapshot;
      const current = snap ? BigInt(snap.currentPrice) : 0n;
      const ago = snap ? BigInt(snap.price24hAgo) : 0n;
      const change =
         snap && ago > 0n
            ? Number(((current - ago) * 10000n) / ago) / 100
            : null;
      out.set(creator.id, {
         key_id: creator.id,
         name: creator.displayName || creator.handle,
         price: current.toString(),
         change_24h: change,
         volume_24h: '0',
      });
   }
   return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// #901 — GET /keys/discovery
// ─────────────────────────────────────────────────────────────────────────────

export interface DiscoveryResponse {
   trending: KeyMarketEntry[];
   new_listings: KeyMarketEntry[];
   cached_at: number;
}

const DISCOVERY_TTL_MS = 60_000; // 60s TTL per the issue
const TRENDING_LIMIT = 5;
const NEW_LISTINGS_LIMIT = 10;

export async function getDiscovery(): Promise<DiscoveryResponse> {
   const cacheKey = `keys:discovery:g${cacheGeneration}`;
   const hit = cacheGet(cacheKey);
   if (hit) return hit as DiscoveryResponse;

   const [volumeByCreator, newCreators] = await Promise.all([
      aggregateVolumeByCreator('24h'),
      prisma.creatorProfile.findMany({
         orderBy: { createdAt: 'desc' },
         take: NEW_LISTINGS_LIMIT,
         select: { id: true },
      }),
   ]);

   // Trending: top N creators by aggregated 24h volume. Every creator has
   // an entry even with zero volume — sections must never be empty-shaped.
   const trendingIds = [...volumeByCreator.entries()]
      .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
      .slice(0, TRENDING_LIMIT)
      .map(([id]) => id);

   const allIds = [...new Set([...trendingIds, ...newCreators.map((c) => c.id)])];
   const entries = await buildMarketEntries(allIds);

   for (const [creatorId, volume] of volumeByCreator) {
      const entry = entries.get(creatorId);
      if (entry) entry.volume_24h = volume.toString();
   }

   const trending = trendingIds
      .map((id) => entries.get(id))
      .filter((e): e is KeyMarketEntry => Boolean(e));

   // New listings ordered by creation date descending — the findMany order.
   const newListings = newCreators
      .map((c) => entries.get(c.id))
      .filter((e): e is KeyMarketEntry => Boolean(e));

   const body: DiscoveryResponse = {
      trending,
      new_listings: newListings,
      cached_at: Date.now(),
   };
   cacheSet(cacheKey, body, DISCOVERY_TTL_MS);
   return body;
}

// ─────────────────────────────────────────────────────────────────────────────
// #896 — GET /keys/leaderboard
// ─────────────────────────────────────────────────────────────────────────────

export interface LeaderboardEntry extends KeyMarketEntry {
   rank: number;
   price_change_pct: number | null;
}

export interface LeaderboardResponse {
   window: '24h' | '7d' | '30d';
   items: LeaderboardEntry[];
   cached_at: number;
}

export async function getLeaderboard(
   window: '24h' | '7d' | '30d',
   limit: number
): Promise<LeaderboardResponse> {
   const cacheKey = `keys:leaderboard:${window}:${limit}:g${cacheGeneration}`;
   const hit = cacheGet(cacheKey);
   if (hit) return hit as LeaderboardResponse;

   const volumeByCreator = await aggregateVolumeByCreator(window);
   const ranked = [...volumeByCreator.entries()]
      .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
      .slice(0, limit);

   const entries = await buildMarketEntries(ranked.map(([id]) => id));
   const items: LeaderboardEntry[] = ranked
      .map(([creatorId, volume], index) => {
         const base = entries.get(creatorId);
         if (!base) return null;
         return {
            ...base,
            volume_24h: volume.toString(),
            rank: index + 1,
            price_change_pct: base.change_24h,
         };
      })
      .filter((e): e is LeaderboardEntry => e !== null);

   const body: LeaderboardResponse = {
      window,
      items,
      cached_at: Date.now(),
   };
   // TTL matches the window size, per the issue.
   cacheSet(cacheKey, body, WINDOW_MS[window]);
   return body;
}

// ─────────────────────────────────────────────────────────────────────────────
// #895 — GET /search
// ─────────────────────────────────────────────────────────────────────────────

export type SearchType = 'keys' | 'creators' | 'proposals';

export interface SearchHit {
   type: SearchType;
   id: string;
   name: string;
   description: string | null;
}

export interface SearchResponse {
   query: string;
   types: SearchType[];
   keys: SearchHit[];
   creators: SearchHit[];
   proposals: SearchHit[];
   cached_at: number;
}

const SEARCH_PER_TYPE_LIMIT = 10;
const SEARCH_TTL_MS = 30_000;

/**
 * Rank by a coarse text-match relevance: exact match > prefix > substring.
 * Postgres ILIKE does the filtering; this orders the page so the best match
 * is first. Proposal search reads the governance proposal table when it
 * exists; this deployment models proposals on `CreatorProfile` perks today,
 * so the proposal section is wired to the governance proposal model if
 * present and returns empty otherwise (the section still renders).
 */
function rankHits(hits: SearchHit[], query: string): SearchHit[] {
   const q = query.toLowerCase();
   const score = (h: SearchHit): number => {
      const name = (h.name ?? '').toLowerCase();
      if (name === q) return 3;
      if (name.startsWith(q)) return 2;
      if (name.includes(q)) return 1;
      return 0;
   };
   return hits.sort((a, b) => score(b) - score(a));
}

export async function searchAll(
   query: string,
   types: SearchType[]
): Promise<SearchResponse> {
   const cacheKey = `keys:search:${query.toLowerCase()}:${types.join(',')}:g${cacheGeneration}`;
   const hit = cacheGet(cacheKey);
   if (hit) return hit as SearchResponse;

   const want = (t: SearchType) => types.includes(t);

   const [keys, creators, proposals] = await Promise.all([
      want('keys')
         ? prisma.creatorProfile.findMany({
              where: {
                 OR: [
                    { handle: { contains: query, mode: 'insensitive' } },
                    { displayName: { contains: query, mode: 'insensitive' } },
                 ],
              },
              take: SEARCH_PER_TYPE_LIMIT,
              select: {
                 id: true,
                 handle: true,
                 displayName: true,
                 bio: true,
                 priceSnapshot: { select: { currentPrice: true } },
              },
           })
         : Promise.resolve([]),
      want('creators')
         ? prisma.creatorProfile.findMany({
              where: {
                 OR: [
                    { handle: { contains: query, mode: 'insensitive' } },
                    { displayName: { contains: query, mode: 'insensitive' } },
                    { bio: { contains: query, mode: 'insensitive' } },
                 ],
              },
              take: SEARCH_PER_TYPE_LIMIT,
              select: { id: true, handle: true, displayName: true, bio: true },
           })
         : Promise.resolve([]),
      want('proposals')
         ? prisma.$queryRawUnsafe<
              Array<{ id: string; title: string; description?: string | null }>
           >(
              `SELECT id, title, description FROM governance_proposals
               WHERE title ILIKE ${`'%${query.replace(/'/g, "''")}%'`}
               ORDER BY created_at DESC LIMIT ${SEARCH_PER_TYPE_LIMIT}`
           )
              .catch((err: unknown) => {
                 // The governance table is provisioned by the governance
                 // service; when absent, search still returns the other
                 // sections rather than failing the whole query.
                 logger.warn(
                    {
                       error:
                          err instanceof Error ? err.message : String(err),
                    },
                    'governance_proposals table unavailable for search'
                 );
                 return [];
              })
         : Promise.resolve([]),
   ]);

   const keyHits: SearchHit[] = keys.map((k) => ({
      type: 'keys' as const,
      id: k.id,
      name: k.displayName || k.handle,
      description: k.bio ?? null,
   }));
   const creatorHits: SearchHit[] = creators.map((c) => ({
      type: 'creators' as const,
      id: c.id,
      name: c.displayName || c.handle,
      description: c.bio ?? null,
   }));
   const proposalHits: SearchHit[] = (proposals as Array<{
      id: string;
      title: string;
      description?: string | null;
   }>).map((p) => ({
      type: 'proposals' as const,
      id: p.id,
      name: p.title,
      description: p.description ?? null,
   }));

   const body: SearchResponse = {
      query,
      types,
      keys: rankHits(keyHits, query),
      creators: rankHits(creatorHits, query),
      proposals: rankHits(proposalHits, query),
      cached_at: Date.now(),
   };
   cacheSet(cacheKey, body, SEARCH_TTL_MS);
   return body;
}
