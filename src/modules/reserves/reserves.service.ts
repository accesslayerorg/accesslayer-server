// src/modules/reserves/reserves.service.ts
//
// Read model for per-key reserve balances (#1140), backed by the
// `key_reserves` table maintained from ReserveAccrued / ReserveDeployed
// contract events.
//
// GET /keys/:key_id/reserve returns the reserve balance, the key's current
// market cap (price snapshot × circulating supply), the reserve ratio in
// basis points, and a `low_reserve` flag when the ratio falls below 1000
// bps (10% of market cap) — the frontend's liquidity backstop indicator.
//
// Responses are cached in Redis for 60s and invalidated per key by the
// reserve indexer after every reserve event.

import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';
import {
   KEY_RESERVE_CACHE_TTL_SECONDS,
   keyReserveCacheKey,
} from '../../constants/redis.constants';
import { resolveCreatorId } from '../whitelist/whitelist.service';

/** Reserve ratio below which a key is flagged low (10% of market cap). */
export const LOW_RESERVE_THRESHOLD_BPS = 1000;

/** XLM stroops per whole XLM. */
const STROOPS_PER_XLM = 10_000_000;

/** Reserve balance response for GET /keys/:key_id/reserve. */
export interface KeyReserveResponse {
   key_id: string;
   reserve_balance: string;
   market_cap: string;
   reserve_ratio_bps: number;
   low_reserve: boolean;
}

/** Drops the cached reserve response for a key. Called by the indexer. */
export async function invalidateKeyReserveCache(keyId: string): Promise<void> {
   await cacheInvalidate(keyReserveCacheKey(keyId));
}

/**
 * Maps any key identifier to the canonical CreatorProfile.id used as
 * `keyId` in the key_reserves table.
 */
export async function resolveReserveKeyId(keyId: string): Promise<string> {
   return (await resolveCreatorId(keyId)) ?? keyId;
}

/**
 * Returns the reserve balance, market cap and ratio for a key. Keys with
 * no reserve accrued report a zero balance (not 404), per the issue.
 */
export async function getKeyReserve(
   keyId: string
): Promise<KeyReserveResponse> {
   const resolvedKeyId = await resolveReserveKeyId(keyId);
   const cacheKey = keyReserveCacheKey(resolvedKeyId);

   try {
      const cached = await cacheGetJson<KeyReserveResponse>(cacheKey);
      if (cached !== null) {
         logger.debug({ keyId: resolvedKeyId }, 'Key reserve cache hit');
         return cached;
      }
   } catch {
      // Cache read failures fall through to the database.
   }

   const [reserve, creator] = await Promise.all([
      prisma.keyReserve.findUnique({
         where: { keyId: resolvedKeyId },
         select: { balance: true },
      }),
      prisma.creatorProfile.findFirst({
         where: {
            OR: [{ id: resolvedKeyId }, { handle: resolvedKeyId }],
         },
         select: { id: true, circulatingSupply: true },
      }),
   ]);

   const reserveBalance = Number(reserve?.balance ?? 0);

   // Market cap = current price (stroops → XLM) × circulating supply.
   let marketCap = 0;
   if (creator) {
      const snapshot = await prisma.creatorPriceSnapshot.findUnique({
         where: { creatorId: creator.id },
         select: { currentPrice: true },
      });
      if (snapshot) {
         const priceXlm = Number(snapshot.currentPrice) / STROOPS_PER_XLM;
         marketCap = priceXlm * Number(creator.circulatingSupply);
      }
   }

   // Ratio in basis points; a key with no market cap yet reports 0 and is
   // never flagged low (nothing to compare the backstop against).
   const reserveRatioBps =
      marketCap > 0 ? Math.round((reserveBalance / marketCap) * 10_000) : 0;
   const lowReserve =
      marketCap > 0 &&
      reserveBalance >= 0 &&
      reserveRatioBps < LOW_RESERVE_THRESHOLD_BPS;

   const result: KeyReserveResponse = {
      key_id: resolvedKeyId,
      reserve_balance: reserveBalance.toFixed(7),
      market_cap: marketCap.toFixed(7),
      reserve_ratio_bps: reserveRatioBps,
      low_reserve: lowReserve,
   };

   try {
      await cacheSetJson(cacheKey, result, KEY_RESERVE_CACHE_TTL_SECONDS);
   } catch {
      // Cache write failures are non-critical.
   }

   return result;
}
