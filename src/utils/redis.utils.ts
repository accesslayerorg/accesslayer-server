// src/utils/redis.utils.ts
// Shared Redis access layer built on ioredis.
//
// A single lazy singleton is used so modules can `import { redis } from ...`
// without worrying about connection lifecycle. All commands are wrapped so a
// down/unreachable Redis degrades to "cache miss" instead of throwing inside
// request handlers — caching must never take the API down.
//
// When ENABLE_REDIS_CACHE is false (or the connection fails) callers get
// null reads and no-op writes, keeping behaviour correct but uncached.

import { Redis } from 'ioredis';
import { envConfig } from '../config';
import { logger } from './logger.utils';

const globalForRedis = globalThis as unknown as {
   __accesslayerRedis?: Redis | null;
};

function createRedisClient(): Redis | null {
   if (!envConfig.ENABLE_REDIS_CACHE) {
      return null;
   }

   try {
      const client = new Redis(envConfig.REDIS_URL, {
         lazyConnect: false,
         maxRetriesPerRequest: 1,
         enableOfflineQueue: false,
         retryStrategy: (attempt: number) => Math.min(attempt * 500, 5000),
      });

      client.on('error', (error: Error) => {
         logger.error(
            { type: 'redis_error', error: error.message },
            'Redis client error'
         );
      });

      return client;
   } catch (error) {
      logger.error(
         {
            type: 'redis_init_failed',
            error: error instanceof Error ? error.message : String(error),
         },
         'Failed to initialise Redis client'
      );
      return null;
   }
}

/** Lazily-created shared Redis client. `null` when caching is disabled. */
export function getRedisClient(): Redis | null {
   if (globalForRedis.__accesslayerRedis === undefined) {
      globalForRedis.__accesslayerRedis = createRedisClient();
   }
   return globalForRedis.__accesslayerRedis;
}

/**
 * Read a string value from Redis. Returns `null` on miss or when Redis is
 * unavailable so callers treat outages as cache misses.
 */
export async function cacheGet(key: string): Promise<string | null> {
   const client = getRedisClient();
   if (!client) return null;
   try {
      return await client.get(key);
   } catch (error) {
      logger.warn(
         {
            type: 'redis_get_failed',
            key,
            error: error instanceof Error ? error.message : String(error),
         },
         'Redis GET failed; treating as cache miss'
      );
      return null;
   }
}

/**
 * Read a raw string value. Returns `null` on miss or when Redis is
 * unavailable so callers treat outages as cache misses.
 */
export async function cacheGetRaw(key: string): Promise<string | null> {
   return cacheGet(key);
}

/**
 * Read and JSON-parse a cached value. Returns `null` on miss, parse failure,
 * or Redis unavailability.
 */
export async function cacheGetJson<T>(key: string): Promise<T | null> {
   const raw = await cacheGet(key);
   if (raw === null) return null;
   try {
      return JSON.parse(raw) as T;
   } catch {
      logger.warn(
         { type: 'redis_cache_corrupt', key },
         'Cached value failed JSON parsing; treating as cache miss'
      );
      return null;
   }
}

/**
 * Write a JSON-serialisable value with a TTL in seconds. No-op failures are
 * logged at warn level; callers never need to handle them.
 */
export async function cacheSetJson(
   key: string,
   value: unknown,
   ttlSeconds: number
): Promise<void> {
   const client = getRedisClient();
   if (!client) return;
   try {
      await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
   } catch (error) {
      logger.warn(
         {
            type: 'redis_set_failed',
            key,
            error: error instanceof Error ? error.message : String(error),
         },
         'Redis SET failed; skipping cache write'
      );
   }
}

/** Store a raw response payload (status + body) for idempotency replay. */
export async function cacheSetRaw(
   key: string,
   value: string,
   ttlSeconds: number
): Promise<void> {
   const client = getRedisClient();
   if (!client) return;
   try {
      await client.set(key, value, 'EX', ttlSeconds);
   } catch (error) {
      logger.warn(
         {
            type: 'redis_set_failed',
            key,
            error: error instanceof Error ? error.message : String(error),
         },
         'Redis SET failed; skipping cache write'
      );
   }
}

/**
 * Delete one or more keys. Accepts glob patterns which are expanded via SCAN
 * so invalidation never blocks Redis with KEYS.
 */
export async function cacheInvalidate(...keysOrPatterns: string[]): Promise<void> {
   const client = getRedisClient();
   if (!client || keysOrPatterns.length === 0) return;

   const literalKeys: string[] = [];
   const patterns: string[] = [];

   for (const key of keysOrPatterns) {
      if (key.includes('*') || key.includes('?') || key.includes('[')) {
         patterns.push(key);
      } else {
         literalKeys.push(key);
      }
   }

   try {
      for (let i = 0; i < literalKeys.length; i += 100) {
         await client.del(...literalKeys.slice(i, i + 100));
      }

      for (const pattern of patterns) {
         let cursor = '0';
         do {
            const [nextCursor, matched] = await client.scan(
               cursor,
               'MATCH',
               pattern,
               'COUNT',
               200
            );
            cursor = nextCursor;
            if (matched.length > 0) {
               await client.del(...matched);
            }
         } while (cursor !== '0');
      }
   } catch (error) {
      logger.warn(
         {
            type: 'redis_invalidate_failed',
            keysOrPatterns,
            error: error instanceof Error ? error.message : String(error),
         },
         'Redis invalidation failed'
      );
   }
}

/** Close the shared client (used by tests and graceful shutdown). */
export async function disconnectRedis(): Promise<void> {
   const client = globalForRedis.__accesslayerRedis;
   if (client) {
      await client.quit().catch(() => client.disconnect());
      globalForRedis.__accesslayerRedis = undefined;
   }
}

/**

 * Ensure the shared Redis client is initialised. The client connects eagerly
 * on creation (lazyConnect is disabled), so simply touching the singleton is
 * enough to "connect". No-op when caching is disabled (returns null).
 */
export async function connectRedis(): Promise<void> {
   const client = getRedisClient();
   if (client && client.status !== 'ready') {
      await client.connect().catch(() => {
         // Connection failures are non-fatal; caching degrades to cache-miss.
      });
   }
}

export const getRedis = getRedisClient;
export const redis = getRedisClient;
