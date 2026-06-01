// src/utils/heartbeat.service.ts
// In-memory heartbeat tracker for background worker processes.

import { envConfig } from '../config';

export type HeartbeatStatus = 'healthy' | 'degraded' | 'unknown';

export interface HeartbeatState {
   service: string;
   status: HeartbeatStatus;
   lastSuccessfulRun: string | null;
   staleSinceMs: number | null;
}

/**
 * Tracks heartbeat state for a background worker process.
 *
 * The indexer (or any long-running worker) calls `recordHeartbeat()`
 * on each successful run.  Consumers call `getStatus()` to determine
 * whether the worker is healthy, degraded (stale), or unknown (never
 * reported).
 */
export class HeartbeatService {
   private lastSuccessfulRun: Date | null = null;

   constructor(
      private readonly serviceName: string,
      private readonly staleThresholdMs: number
   ) {}

   /** Record a successful heartbeat right now. */
   recordHeartbeat(): Date {
      this.lastSuccessfulRun = new Date();
      return this.lastSuccessfulRun;
   }

   /** Return the current heartbeat status. */
   getStatus(): HeartbeatState {
      if (!this.lastSuccessfulRun) {
         return {
            service: this.serviceName,
            status: 'unknown',
            lastSuccessfulRun: null,
            staleSinceMs: null,
         };
      }

      const elapsedMs = Date.now() - this.lastSuccessfulRun.getTime();
      const isStale = elapsedMs > this.staleThresholdMs;

      return {
         service: this.serviceName,
         status: isStale ? 'degraded' : 'healthy',
         lastSuccessfulRun: this.lastSuccessfulRun.toISOString(),
         staleSinceMs: isStale ? elapsedMs : null,
      };
   }

   /** Reset state — primarily useful for testing. */
   reset(): void {
      this.lastSuccessfulRun = null;
   }
}

/** Singleton instance for the indexer worker. */
export const indexerHeartbeat = new HeartbeatService(
   'indexer',
   envConfig.INDEXER_HEARTBEAT_STALE_THRESHOLD_MS
);
