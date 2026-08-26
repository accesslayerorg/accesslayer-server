// src/utils/redis.utils.ts
// Singleton Redis client used for caching and idempotency keys.

import { createClient } from 'redis';
import { envConfig } from '../config';
import { logger } from './logger.utils';

type RedisClient = ReturnType<typeof createClient>;

declare global {
   var redisClient: RedisClient | undefined;
}

function buildClient(): RedisClient {
   const client = createClient({
      url: envConfig.REDIS_URL,
   });

   client.on('error', (err) => {
      logger.error(
         { type: 'redis_error', message: err.message },
         'Redis client error'
      );
   });

   client.on('connect', () => {
      logger.info('Redis client connected');
   });

   return client;
}

/**
 * Returns the process-wide Redis client, connecting lazily on first use.
 *
 * The client is cached on `globalThis` so it survives module reloads in
 * development without creating duplicate connections.
 */
export async function getRedisClient(): Promise<RedisClient> {
   if (!global.redisClient) {
      global.redisClient = buildClient();
   }

   const client = global.redisClient;
   if (!client.isOpen) {
      await client.connect();
   }
   return client;
}

/**
 * Gracefully disconnect the singleton client. Primarily used in tests and
 * during shutdown.
 */
export async function closeRedisClient(): Promise<void> {
   const client = global.redisClient;
   if (client && client.isOpen) {
      await client.quit();
   }
   global.redisClient = undefined;
}
