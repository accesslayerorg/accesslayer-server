// src/modules/co-creators/co-creators.service.ts
//
// Read model for the per-key co-creator roster (#1139), backed by the
// `key_cocreators` table maintained from CoCreatorSet / CoCreatorRemoved
// contract events.
//
// Responses are cached in Redis for 60s and invalidated per key by the
// co-creator indexer after every event, so a freshly added or removed
// co-creator is reflected within one event-processing hop.

import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';
import {
   KEY_COCREATOR_CACHE_TTL_SECONDS,
   keyCoCreatorCachePattern,
   keyCoCreatorDetailCacheKey,
   keyCoCreatorListCacheKey,
} from '../../constants/redis.constants';
import { resolveCreatorId } from '../whitelist/whitelist.service';

/** One active co-creator in the roster. */
export interface CoCreatorListItem {
   wallet: string;
   role: string;
   added_at: string;
   share_bps: number | null;
}

/** Full co-creator detail, including removal state. */
export interface CoCreatorDetail {
   key_id: string;
   wallet: string;
   role: string;
   active: boolean;
   added_at: string;
   removed_at: string | null;
   share_bps: number | null;
}

/**
 * Drops every cached co-creator response for a key (list + wallet
 * details). Called by the indexer after every CoCreatorSet /
 * CoCreatorRemoved event.
 */
export async function invalidateCoCreatorCache(keyId: string): Promise<void> {
   await cacheInvalidate(keyCoCreatorCachePattern(keyId));
}

/**
 * Maps any key identifier (CreatorProfile id, handle, or key contract
 * address) to the canonical CreatorProfile.id used as `keyId` in the
 * key_cocreators table. Falls back to the raw identifier when nothing is
 * registered yet, so events that arrive before CREATOR_REGISTERED still
 * land.
 */
export async function resolveCoCreatorKeyId(keyId: string): Promise<string> {
   return (await resolveCreatorId(keyId)) ?? keyId;
}

/**
 * Lists the active co-creator roster for a key (wallet, role, added_at),
 * most recently added first. Removed co-creators are excluded.
 */
export async function listActiveCoCreators(
   keyId: string
): Promise<{ key_id: string; co_creators: CoCreatorListItem[] }> {
   const resolvedKeyId = await resolveCoCreatorKeyId(keyId);
   const cacheKey = keyCoCreatorListCacheKey(resolvedKeyId);

   try {
      const cached = await cacheGetJson<{
         key_id: string;
         co_creators: CoCreatorListItem[];
      }>(cacheKey);
      if (cached !== null) {
         logger.debug(
            { keyId: resolvedKeyId },
            'Co-creator list cache hit'
         );
         return cached;
      }
   } catch {
      // Cache read failures fall through to the database.
   }

   const rows = await prisma.keyCoCreator.findMany({
      where: { keyId: resolvedKeyId, active: true },
      orderBy: { addedAt: 'desc' },
      select: {
         wallet: true,
         role: true,
         addedAt: true,
         shareBps: true,
      },
   });

   const result = {
      key_id: resolvedKeyId,
      co_creators: rows.map(row => ({
         wallet: row.wallet,
         role: row.role,
         added_at: row.addedAt.toISOString(),
         share_bps: row.shareBps,
      })),
   };

   try {
      await cacheSetJson(cacheKey, result, KEY_COCREATOR_CACHE_TTL_SECONDS);
   } catch {
      // Cache write failures are non-critical.
   }

   return result;
}

/**
 * Returns the detail for one co-creator of a key, including role and
 * removal state. Returns null when the wallet was never a co-creator.
 */
export async function getCoCreatorDetail(
   keyId: string,
   wallet: string
): Promise<CoCreatorDetail | null> {
   const resolvedKeyId = await resolveCoCreatorKeyId(keyId);
   const normalizedWallet = wallet.trim();
   const cacheKey = keyCoCreatorDetailCacheKey(resolvedKeyId, normalizedWallet);

   try {
      const cached = await cacheGetJson<CoCreatorDetail>(cacheKey);
      if (cached !== null) {
         logger.debug(
            { keyId: resolvedKeyId, wallet: normalizedWallet },
            'Co-creator detail cache hit'
         );
         return cached;
      }
   } catch {
      // Cache read failures fall through to the database.
   }

   const row = await prisma.keyCoCreator.findUnique({
      where: {
         keyId_wallet: { keyId: resolvedKeyId, wallet: normalizedWallet },
      },
      select: {
         keyId: true,
         wallet: true,
         role: true,
         active: true,
         addedAt: true,
         removedAt: true,
         shareBps: true,
      },
   });

   if (!row) {
      return null;
   }

   const result: CoCreatorDetail = {
      key_id: row.keyId,
      wallet: row.wallet,
      role: row.role,
      active: row.active,
      added_at: row.addedAt.toISOString(),
      removed_at: row.removedAt ? row.removedAt.toISOString() : null,
      share_bps: row.shareBps,
   };

   try {
      await cacheSetJson(cacheKey, result, KEY_COCREATOR_CACHE_TTL_SECONDS);
   } catch {
      // Cache write failures are non-critical.
   }

   return result;
}
