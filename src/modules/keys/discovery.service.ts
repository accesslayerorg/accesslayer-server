// src/modules/keys/discovery.service.ts
//
// Powers GET /discovery/trending, /discovery/new and /discovery/graduating.
//
// Volume and milestone data come from the contract event index (Trade rows,
// CreatorPriceSnapshot, and circulatingSupply on CreatorProfile). All three
// sections share one in-process TTL cache keyed by a generation counter;
// the counter is bumped on every trade event and every new key deployment
// so stale data is never served after either of those write paths.

import { prisma } from '../../utils/prisma.utils';

// ─── Cache ────────────────────────────────────────────────────────────────────

const DISCOVERY_TTL_MS = 5 * 60 * 1000; // 5-minute TTL per acceptance criteria
const MAX_CACHE_ENTRIES = 50;

type CacheEntry<T> = { body: T; expiresAt: number };
const _cache = new Map<string, CacheEntry<unknown>>();

/** Bumped on trade events and new key deployments to bust all discovery cache entries. */
let generation = 0;

export function invalidateDiscoveryCache(): void {
   generation += 1;
   _cache.clear();
}

function cacheGet<T>(key: string): T | undefined {
   const entry = _cache.get(key) as CacheEntry<T> | undefined;
   if (!entry) return undefined;
   if (entry.expiresAt <= Date.now()) {
      _cache.delete(key);
      return undefined;
   }
   return entry.body;
}

function cacheSet<T>(key: string, body: T): void {
   if (_cache.size >= MAX_CACHE_ENTRIES) {
      const sorted = [..._cache.entries()].sort(
         (a, b) => a[1].expiresAt - b[1].expiresAt
      );
      for (let i = 0; i < Math.min(5, sorted.length); i++) {
         _cache.delete(sorted[i][0]);
      }
   }
   _cache.set(key, { body, expiresAt: Date.now() + DISCOVERY_TTL_MS });
}

// ─── Shared types ──────────────────────────────────────────────────────────────

export interface DiscoveryKey {
   key_id: string;
   handle: string;
   name: string;
   /** Current bonding-curve price in stroops (string to avoid precision loss). */
   price: string;
   /** Percentage price change over the last 24 h; null when no prior snapshot. */
   change_24h: number | null;
   /** Aggregate 24 h trade volume in stroops. */
   volume_24h: string;
}

export interface TrendingKey extends DiscoveryKey {
   /** Relative velocity of 24 h volume compared to the top performer. */
   velocity_badge: 'hot' | 'rising' | 'active';
}

export interface NewKey extends DiscoveryKey {
   /** ISO timestamp of when the key was first registered. */
   deployed_at: string;
}

export interface GraduatingKey extends DiscoveryKey {
   circulating_supply: number;
   final_milestone: number;
   /** Ratio of current supply to final milestone, clamped [0, 1). */
   progress: number;
}

// ─── Volume aggregation ────────────────────────────────────────────────────────

async function volume24hByCreator(): Promise<Map<string, bigint>> {
   const since = new Date(Date.now() - 24 * 60 * 60 * 1_000);
   const rows = await prisma.trade.findMany({
      where: { timestamp: { gte: since } },
      select: { creatorId: true, price: true },
   });
   const out = new Map<string, bigint>();
   for (const { creatorId, price } of rows) {
      out.set(creatorId, (out.get(creatorId) ?? 0n) + BigInt(price));
   }
   return out;
}

function velocityBadge(
   volume: bigint,
   topVolume: bigint
): TrendingKey['velocity_badge'] {
   if (topVolume === 0n) return 'active';
   const pct = Number((volume * 100n) / topVolume);
   if (pct >= 70) return 'hot';
   if (pct >= 30) return 'rising';
   return 'active';
}

// ─── Profile helpers ──────────────────────────────────────────────────────────

type ProfileRow = Awaited<
   ReturnType<typeof prisma.creatorProfile.findMany>
>[number] & {
   priceSnapshot: { currentPrice: string; price24hAgo: string } | null;
};

async function fetchProfiles(ids: string[]): Promise<Map<string, ProfileRow>> {
   if (ids.length === 0) return new Map();
   const rows = await prisma.creatorProfile.findMany({
      where: { id: { in: ids } },
      select: {
         id: true,
         handle: true,
         displayName: true,
         circulatingSupply: true,
         createdAt: true,
         supplyCap: true,
         curveMilestones: true,
         priceSnapshot: { select: { currentPrice: true, price24hAgo: true } },
      },
   });
   return new Map(rows.map(r => [r.id, r as unknown as ProfileRow]));
}

function baseKey(p: ProfileRow, vol: bigint): DiscoveryKey {
   const snap = p.priceSnapshot;
   const current = snap ? BigInt(snap.currentPrice) : 0n;
   const ago = snap ? BigInt(snap.price24hAgo) : 0n;
   const change =
      snap && ago > 0n ? Number(((current - ago) * 10_000n) / ago) / 100 : null;
   return {
      key_id: p.id,
      handle: p.handle,
      name: p.displayName,
      price: current.toString(),
      change_24h: change,
      volume_24h: vol.toString(),
   };
}

/** Extracts the highest threshold from the curveMilestones JSON column. */
function highestCurveThreshold(raw: unknown): number | null {
   if (!Array.isArray(raw) || raw.length === 0) return null;
   let max = 0;
   for (const entry of raw) {
      const t =
         typeof entry === 'number'
            ? entry
            : entry && typeof entry === 'object' && 'threshold' in entry
              ? Number((entry as { threshold: unknown }).threshold)
              : NaN;
      if (Number.isFinite(t) && t > max) max = t;
   }
   return max > 0 ? max : null;
}

function toNumber(supply: unknown): number {
   if (
      supply !== null &&
      typeof supply === 'object' &&
      'toNumber' in (supply as object)
   ) {
      return (supply as { toNumber(): number }).toNumber();
   }
   return Number(supply);
}

// ─── GET /discovery/trending ──────────────────────────────────────────────────

export interface TrendingResponse {
   items: TrendingKey[];
   cached_at: number;
}

export async function getTrending(limit: number): Promise<TrendingResponse> {
   const cacheKey = `discovery:trending:${limit}:g${generation}`;
   const hit = cacheGet<TrendingResponse>(cacheKey);
   if (hit) return hit;

   const volMap = await volume24hByCreator();

   const ranked = [...volMap.entries()]
      .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
      .slice(0, limit);

   const profiles = await fetchProfiles(ranked.map(([id]) => id));
   const topVolume = ranked[0]?.[1] ?? 0n;

   const items: TrendingKey[] = ranked
      .flatMap(([id, vol]) => {
         const p = profiles.get(id);
         if (!p) return [];
         return [{ ...baseKey(p, vol), velocity_badge: velocityBadge(vol, topVolume) }];
      });

   const body: TrendingResponse = { items, cached_at: Date.now() };
   cacheSet(cacheKey, body);
   return body;
}

// ─── GET /discovery/new ───────────────────────────────────────────────────────

export interface NewResponse {
   items: NewKey[];
   cached_at: number;
}

const NEW_KEY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

export async function getNewKeys(limit: number): Promise<NewResponse> {
   const cacheKey = `discovery:new:${limit}:g${generation}`;
   const hit = cacheGet<NewResponse>(cacheKey);
   if (hit) return hit;

   const since = new Date(Date.now() - NEW_KEY_WINDOW_MS);
   const recent = await prisma.creatorProfile.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, createdAt: true },
   });

   const volMap = await volume24hByCreator();
   const profiles = await fetchProfiles(recent.map(r => r.id));

   const items: NewKey[] = recent.flatMap(r => {
      const p = profiles.get(r.id);
      if (!p) return [];
      return [{ ...baseKey(p, volMap.get(r.id) ?? 0n), deployed_at: r.createdAt.toISOString() }];
   });

   const body: NewResponse = { items, cached_at: Date.now() };
   cacheSet(cacheKey, body);
   return body;
}

// ─── GET /discovery/graduating ─────────────────────────────────────────────────

export interface GraduatingResponse {
   items: GraduatingKey[];
   cached_at: number;
}

/** Keys whose circulating supply is within 10 % of their final supply milestone. */
export async function getGraduating(limit: number): Promise<GraduatingResponse> {
   const cacheKey = `discovery:graduating:${limit}:g${generation}`;
   const hit = cacheGet<GraduatingResponse>(cacheKey);
   if (hit) return hit;

   const candidates = await prisma.creatorProfile.findMany({
      where: { status: 'Active', deprecatedAt: null },
      select: {
         id: true,
         handle: true,
         displayName: true,
         circulatingSupply: true,
         createdAt: true,
         supplyCap: true,
         curveMilestones: true,
         priceSnapshot: { select: { currentPrice: true, price24hAgo: true } },
      },
   });

   const volMap = await volume24hByCreator();
   const items: GraduatingKey[] = [];

   for (const c of candidates) {
      const curveMax = highestCurveThreshold(c.curveMilestones);
      // supplyCap takes precedence; fall back to the highest curve tier.
      const finalMilestone = c.supplyCap ?? curveMax;
      if (!finalMilestone || finalMilestone <= 0) continue;

      const supply = toNumber(c.circulatingSupply);
      if (supply >= finalMilestone) continue; // already graduated

      const progress = supply / finalMilestone;
      if (progress < 0.9) continue; // not within 10%

      items.push({
         ...baseKey(c as unknown as ProfileRow, volMap.get(c.id) ?? 0n),
         circulating_supply: supply,
         final_milestone: finalMilestone,
         progress: Math.round(progress * 10_000) / 10_000,
      });
   }

   // Closest to graduation first.
   items.sort((a, b) => b.progress - a.progress);
   items.splice(limit);

   const body: GraduatingResponse = { items, cached_at: Date.now() };
   cacheSet(cacheKey, body);
   return body;
}
