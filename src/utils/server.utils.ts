// src/utils/server.utils.ts
// Builds the Express app for use in integration tests without binding a port.
import app from '../app';

/**
 * Returns the configured Express application instance. Used by integration
 * tests so they can drive the full HTTP stack via supertest without starting
 * a listening server.
 */
export async function createServer() {
   return app;
}
// Test/utility helpers for building the Express app and managing Redis.
//
// Integration tests import `createServer` to obtain a fully-configured app
// instance without starting the long-running listeners/background jobs that
// `src/server.ts` boots. Redis helpers are re-exported here so callers that
// previously imported them from this module keep working.

import { connectRedis, disconnectRedis } from './redis.utils';

export { connectRedis, disconnectRedis };