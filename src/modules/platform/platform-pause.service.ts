// src/modules/platform/platform-pause.service.ts
// Platform-wide and per-key trade pause state (#988).
//
// Pause state is written when the indexer processes PlatformPaused /
// PlatformResumed (and the per-key equivalents) contract events, and is read
// by the trade validation middleware before any trade is executed.
//
// Reads go to Redis first — via the shared cache helpers — so a pause
// propagates across server instances within seconds. An in-process fallback
// map keeps the state readable (and tests deterministic) when Redis caching
// is disabled or unreachable.

import {
   cacheGetJson,
   cacheInvalidate,
   cacheSetJson,
} from '../../utils/redis.utils';
import { prisma } from '../../utils/prisma.utils';

/** Redis key holding the platform-wide pause state. */
export const PLATFORM_PAUSE_CACHE_KEY = 'platform:pause:state';
/** Redis key prefix holding per-key pause state. */
export const KEY_PAUSE_CACHE_PREFIX = 'platform:pause:key:';
/**
 * Long TTL so an active pause never silently expires out of the cache. Pause
 * state is removed explicitly when the matching resume event is indexed.
 */
export const PAUSE_STATE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface PauseMetadata {
   /** Wallet/contract that triggered the pause, when the event carries it. */
   actor: string | null;
   /** ISO timestamp the pause took effect. */
   pausedAt: string | null;
}

export interface PlatformPauseState extends PauseMetadata {
   paused: boolean;
}

export interface KeyPauseState extends PauseMetadata {
   keyId: string;
   paused: boolean;
}

const memory = {
   platform: null as PlatformPauseState | null,
   keys: new Map<string, KeyPauseState>(),
};

function keyCacheKey(keyId: string): string {
   return `${KEY_PAUSE_CACHE_PREFIX}${keyId}`;
}

/**
 * Current platform-wide pause state. Defaults to "not paused" when nothing
 * has been indexed or the cache was cleared by a PlatformResumed event.
 */
export async function getPlatformPauseState(): Promise<PlatformPauseState> {
   const cached = await cacheGetJson<PlatformPauseState>(
      PLATFORM_PAUSE_CACHE_KEY
   );
   if (cached) {
      return cached;
   }
   if (memory.platform) {
      return memory.platform;
   }
   return { paused: false, pausedAt: null, actor: null };
}

/** Marks the platform paused and caches the state with its metadata. */
export async function setPlatformPaused(
   actor: string | null,
   pausedAt: Date = new Date()
): Promise<PlatformPauseState> {
   const state: PlatformPauseState = {
      paused: true,
      pausedAt: pausedAt.toISOString(),
      actor: actor ?? null,
   };
   memory.platform = state;
   await cacheSetJson(PLATFORM_PAUSE_CACHE_KEY, state, PAUSE_STATE_TTL_SECONDS);
   return state;
}

/** Clears the platform pause state (PlatformResumed). */
export async function clearPlatformPaused(): Promise<void> {
   memory.platform = { paused: false, pausedAt: null, actor: null };
   await cacheInvalidate(PLATFORM_PAUSE_CACHE_KEY);
}

/** Cached per-key pause state, or null when the key has never been paused. */
export async function getCachedKeyPauseState(
   keyId: string
): Promise<KeyPauseState | null> {
   const cached = await cacheGetJson<KeyPauseState>(keyCacheKey(keyId));
   if (cached) {
      return cached;
   }
   return memory.keys.get(keyId) ?? null;
}

/** Marks a single key paused and caches the state with its metadata. */
export async function setKeyPaused(
   keyId: string,
   actor: string | null,
   pausedAt: Date = new Date()
): Promise<KeyPauseState> {
   const state: KeyPauseState = {
      keyId,
      paused: true,
      pausedAt: pausedAt.toISOString(),
      actor: actor ?? null,
   };
   memory.keys.set(keyId, state);
   await cacheSetJson(keyCacheKey(keyId), state, PAUSE_STATE_TTL_SECONDS);
   return state;
}

/** Clears a single key's pause state. */
export async function clearKeyPaused(keyId: string): Promise<void> {
   memory.keys.delete(keyId);
   await cacheInvalidate(keyCacheKey(keyId));
}

/**
 * Whether trades for a key are currently paused.
 *
 * Checks the cache for the identifier as given, then falls back to the
 * persisted `CreatorProfile.tradingPaused` flag so a pause set through the
 * admin API is also enforced. A key with no cached pause and no profile is
 * treated as active.
 */
export async function isKeyPaused(keyId: string): Promise<boolean> {
   const cached = await getCachedKeyPauseState(keyId);
   if (cached) {
      return cached.paused;
   }

   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: { id: true, tradingPaused: true },
   });
   if (!creator) {
      return false;
   }

   const canonical = await getCachedKeyPauseState(creator.id);
   if (canonical) {
      return canonical.paused;
   }
   return Boolean(creator.tradingPaused);
}

/** Clears all in-process pause state (tests only). */
export function resetPlatformPauseCache(): void {
   memory.platform = null;
   memory.keys.clear();
}
