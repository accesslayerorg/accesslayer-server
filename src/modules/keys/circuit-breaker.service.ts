// src/modules/keys/circuit-breaker.service.ts
// Read model for a creator key's circuit breaker state (#987).
//
// Responsibilities:
//   - Resolve the key (by profile id or handle) and 404 when it does not exist.
//   - Return the current max_bps configuration, read from the contract and
//     cached in Redis for CIRCUIT_BREAKER_CONFIG_CACHE_TTL_SECONDS (5 minutes
//     by default). When the contract read is unavailable the indexed mirror
//     (CreatorProfile.circuitBreakerThreshold) is used instead.
//   - Return the paginated trip history, newest first (50 per page by default).
//   - Derive the `active` flag by comparing the latest trip's actual bps to the
//     current max_bps configuration.

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { envConfig } from '../../config';
import { circuitBreakerConfigRedisKey } from '../../constants/redis.constants';
import { fetchCircuitBreakerMaxBpsFromContract } from './circuit-breaker-contract';
import type { CircuitBreakerQuery } from './circuit-breaker.schemas';

/** Threshold applied when neither the contract nor the index has a value. */
export const DEFAULT_CIRCUIT_BREAKER_MAX_BPS = 3000;

export type CircuitBreakerConfigSource = 'contract' | 'indexed';

export interface CircuitBreakerConfig {
   /** Configured maximum price movement, in basis points. */
   maxBps: number;
   /** Whether the value came from the contract read or the indexed mirror. */
   source: CircuitBreakerConfigSource;
   /** ISO-8601 timestamp of when the config was resolved (cache write time). */
   cachedAt: string;
}

export interface CircuitBreakerTripEntry {
   id: string;
   actualBps: number;
   maxBps: number | null;
   ledger: number;
   txHash: string;
   eventIndex: number;
   occurredAt: string;
}

export interface CircuitBreakerState {
   keyId: string;
   /** Configured price movement threshold for the key, in basis points. */
   maxBps: number;
   /** True when the latest trip met or exceeded the current threshold. */
   active: boolean;
   config: CircuitBreakerConfig;
   tripCount: number;
   limit: number;
   offset: number;
   /** Trip history, newest first. */
   trips: CircuitBreakerTripEntry[];
}

/** Thrown when the requested key does not exist. */
export class KeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundError';
   }
}

/**
 * Resolve the circuit breaker max_bps for a key.
 *
 * Reads from Redis first; on a miss it queries the contract and caches the
 * result for the configured TTL. Falls back to the indexed mirror so the
 * endpoint keeps serving a threshold when the contract read is unavailable.
 */
export async function getCircuitBreakerConfig(
   keyId: string,
   fallbackMaxBps: number,
   now: Date = new Date()
): Promise<CircuitBreakerConfig> {
   const cacheKey = circuitBreakerConfigRedisKey(keyId);
   const cached = await cacheGetJson<CircuitBreakerConfig>(cacheKey);
   if (
      cached &&
      typeof cached.maxBps === 'number' &&
      Number.isFinite(cached.maxBps)
   ) {
      return cached;
   }

   const contractMaxBps = await fetchCircuitBreakerMaxBpsFromContract(keyId);
   const config: CircuitBreakerConfig = {
      maxBps: contractMaxBps ?? fallbackMaxBps,
      source: contractMaxBps !== null ? 'contract' : 'indexed',
      cachedAt: now.toISOString(),
   };

   await cacheSetJson(
      cacheKey,
      config,
      envConfig.CIRCUIT_BREAKER_CONFIG_CACHE_TTL_SECONDS
   );

   return config;
}

/**
 * Return the current circuit breaker state for a key: the cached max_bps
 * configuration, whether the breaker is currently active, and the paginated
 * trip history (newest first).
 *
 * @throws {KeyNotFoundError} when the key does not exist.
 */
export async function getCircuitBreakerState(
   keyId: string,
   query: CircuitBreakerQuery,
   now: Date = new Date()
): Promise<CircuitBreakerState> {
   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: { id: true, circuitBreakerThreshold: true },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const config = await getCircuitBreakerConfig(
      creator.id,
      creator.circuitBreakerThreshold ?? DEFAULT_CIRCUIT_BREAKER_MAX_BPS,
      now
   );

   const where = { keyId: creator.id };
   const orderBy = [
      { occurredAt: 'desc' as const },
      { id: 'desc' as const },
   ];

   const [tripCount, trips, latest] = await Promise.all([
      prisma.circuitBreakerTrip.count({ where }),
      prisma.circuitBreakerTrip.findMany({
         where,
         orderBy,
         take: query.limit,
         skip: query.offset,
      }),
      prisma.circuitBreakerTrip.findFirst({ where, orderBy }),
   ]);

   const active = latest !== null && latest.actualBps >= config.maxBps;

   return {
      keyId: creator.id,
      maxBps: config.maxBps,
      active,
      config,
      tripCount,
      limit: query.limit,
      offset: query.offset,
      trips: trips.map(trip => ({
         id: trip.id,
         actualBps: trip.actualBps,
         maxBps: trip.maxBps,
         ledger: trip.ledger,
         txHash: trip.txHash,
         eventIndex: trip.eventIndex,
         occurredAt: trip.occurredAt.toISOString(),
      })),
   };
}
