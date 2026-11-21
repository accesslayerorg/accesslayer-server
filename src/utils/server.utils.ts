// src/utils/server.utils.ts
// Test/utility helpers for building the Express app and managing Redis.
//
// Integration tests import `createServer` to obtain a fully-configured app
// instance without starting the long-running listeners/background jobs that
// `src/server.ts` boots. Redis helpers are re-exported here so callers that
// previously imported them from this module keep working.

import app from '../app';
import { connectRedis, disconnectRedis } from './redis.utils';

/** Build and return the configured Express app (without binding a port). */
export async function createServer() {
   return app;
}

export { connectRedis, disconnectRedis };
