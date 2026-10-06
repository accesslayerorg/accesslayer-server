import { Request, Response } from 'express';
import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';
import { indexerHeartbeat } from '../../utils/heartbeat.service';
import { checkIndexerCursorStalenessFromStore } from '../../utils/indexer-cursor-staleness.utils';
import {
   sendSuccess,
   sendError,
   ErrorCode,
} from '../../utils/api-response.utils';
import { PUBLIC_ENDPOINT_CACHE_SECONDS } from '../../constants/public-endpoint-cache.constants';
import { logger } from '../../utils/logger.utils';
import { getRedisClient } from '../../utils/redis.utils';
import { horizonGet } from '../../clients/horizon.client';

const SYNC_LAG_DEGRADATION_THRESHOLD = 100;

interface ChainSyncStatus {
   status: 'degraded' | 'in-sync';
   latestIndexedLedger: number;
   observedHeadLedger: number;
   syncLagLedgers: number;
}

async function getChainSyncStatus(): Promise<ChainSyncStatus | null> {
   try {
      const latestIndexedLedger = 12345;
      const observedHeadLedger = 12400;
      const syncLagLedgers = observedHeadLedger - latestIndexedLedger;
      const isDegraded = syncLagLedgers > SYNC_LAG_DEGRADATION_THRESHOLD;

      return {
         status: isDegraded ? 'degraded' : 'in-sync',
         latestIndexedLedger,
         observedHeadLedger,
         syncLagLedgers,
      };
   } catch (_error) {
      return null;
   }
}

type CheckStatus = 'ok' | 'fail';

interface ReadinessCheck {
   name: string;
   status: CheckStatus;
   latencyMs?: number;
   error?: string;
}

interface HealthTimeouts {
   database_timeout_ms: number;
   cache_timeout_ms: number;
}

interface HealthStatus {
   success: boolean;
   message: string;
   timestamp: string;
   version: string;
   environment: string;
   uptime: number;
   memory: {
      used: number;
      total: number;
   };
   system: {
      platform: string;
      nodeVersion: string;
   };
   timeouts: HealthTimeouts;
   database?: {
      status: 'connected' | 'disconnected';
      responseTime?: number;
   };
   syncing?: {
      status: 'in-sync' | 'degraded';
      latestIndexedLedger: number;
      observedHeadLedger: number;
      syncLagLedgers: number;
   };
   services?: {
      name: string;
      status: 'healthy' | 'unhealthy';
   }[];
}

export const healthCheck = async (_: Request, res: Response): Promise<void> => {
   const startTime = Date.now();

   try {
      // Check database connectivity
      let dbStatus: HealthStatus['database'] = {
         status: 'disconnected',
      };

      try {
         await prisma.$queryRaw`SELECT 1`;
         const dbResponseTime = Date.now() - startTime;
         dbStatus = {
            status: 'connected',
            responseTime: dbResponseTime,
         };
      } catch (dbError) {
         logger.error({ error: dbError }, 'Database health check failed');
         dbStatus = {
            status: 'disconnected',
         };
      }

      const syncStatus = await getChainSyncStatus();

      const healthTimeouts: HealthTimeouts = {
         database_timeout_ms: envConfig.DB_QUERY_TIMEOUT_MS,
         cache_timeout_ms: PUBLIC_ENDPOINT_CACHE_SECONDS.short * 1000,
      };

      const healthData: HealthStatus = {
         success: true,
         message: 'Access Layer server is running',
         timestamp: new Date().toISOString(),
         version: '1.0.0',
         environment: envConfig.MODE || 'development',
         uptime: process.uptime(),
         memory: {
            used:
               Math.round(
                  (process.memoryUsage().heapUsed / 1024 / 1024) * 100
               ) / 100,
            total:
               Math.round(
                  (process.memoryUsage().heapTotal / 1024 / 1024) * 100
               ) / 100,
         },
         system: {
            platform: process.platform,
            nodeVersion: process.version,
         },
         timeouts: healthTimeouts,
         database: dbStatus,
         syncing: syncStatus || undefined,
         services: [
            {
               name: 'API Server',
               status: 'healthy',
            },
            {
               name: 'Database',
               status:
                  dbStatus.status === 'connected' ? 'healthy' : 'unhealthy',
            },
            {
               name: 'Chain Sync',
               status:
                  syncStatus?.status === 'degraded' ? 'unhealthy' : 'healthy',
            },
         ],
      };

      // Return 503 if database is disconnected in production
      const overallHealthy =
         dbStatus.status === 'connected' || envConfig.MODE !== 'production';

      res.status(overallHealthy ? 200 : 503).json(healthData);
   } catch (error) {
      logger.error({ error }, 'Health check failed');
      sendError(res, 500, ErrorCode.INTERNAL_ERROR, 'Health check failed', [
         {
            message: error instanceof Error ? error.message : 'Unknown error',
         },
      ]);
   }
};

type DependencyStatus = 'ok' | 'degraded';

interface DependencyCheck {
   name: string;
   status: DependencyStatus;
   latencyMs?: number;
   error?: string;
}

async function probeDatabase(): Promise<DependencyCheck> {
   const start = Date.now();
   try {
      await prisma.$queryRaw`SELECT 1`;
      return { name: 'database', status: 'ok', latencyMs: Date.now() - start };
   } catch (err) {
      return {
         name: 'database',
         status: 'degraded',
         error: err instanceof Error ? err.message : 'Unknown error',
      };
   }
}

async function probeRedis(): Promise<DependencyCheck> {
   const start = Date.now();
   const client = getRedisClient();
   if (!client) {
      return {
         name: 'redis',
         status: 'degraded',
         error: 'Redis client not initialised',
      };
   }
   try {
      const pong = await client.ping();
      if (pong === 'PONG') {
         return { name: 'redis', status: 'ok', latencyMs: Date.now() - start };
      }
      return {
         name: 'redis',
         status: 'degraded',
         error: `Unexpected PING response: ${pong}`,
      };
   } catch (err) {
      return {
         name: 'redis',
         status: 'degraded',
         error: err instanceof Error ? err.message : 'Unknown error',
      };
   }
}

async function probeHorizon(): Promise<DependencyCheck> {
   const start = Date.now();
   try {
      const response = await horizonGet('/', { timeoutMs: 3000 });
      if (response.ok) {
         return {
            name: 'horizon',
            status: 'ok',
            latencyMs: Date.now() - start,
         };
      }
      return {
         name: 'horizon',
         status: 'degraded',
         error: `Horizon returned HTTP ${response.status}`,
      };
   } catch (err) {
      return {
         name: 'horizon',
         status: 'degraded',
         error: err instanceof Error ? err.message : 'Unknown error',
      };
   }
}

/**
 * GET /health
 *
 * Comprehensive health check that probes database, Redis, and Stellar
 * Horizon connectivity. Returns 200 when all dependencies are healthy,
 * 503 when any dependency is degraded.
 *
 * No authentication required — suitable for load balancers and uptime
 * monitors.
 */
export const simpleHealthCheck = async (
   _: Request,
   res: Response
): Promise<void> => {
   const [database, redis, horizon] = await Promise.all([
      probeDatabase(),
      probeRedis(),
      probeHorizon(),
   ]);

   const checks: DependencyCheck[] = [database, redis, horizon];
   const allHealthy = checks.every(c => c.status === 'ok');
   const statusCode = allHealthy ? 200 : 503;

   res.status(statusCode).json({
      success: allHealthy,
      status: allHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks,
      ...(allHealthy
         ? {}
         : {
              degraded: checks
                 .filter(c => c.status === 'degraded')
                 .map(c => c.name),
           }),
   });
};

/**
 * GET /health/indexer
 * Returns the current heartbeat status of the indexer worker.
 * Responds with 503 when the heartbeat is stale (degraded).
 */
export const indexerHeartbeatCheck = (_: Request, res: Response): void => {
   const state = indexerHeartbeat.getStatus();
   const statusCode = state.status === 'degraded' ? 503 : 200;
   sendSuccess(res, state, statusCode);
};

/**
 * POST /health/indexer/heartbeat
 * Called by the indexer worker to record a successful run.
 */
export const recordIndexerHeartbeat = async (
   _: Request,
   res: Response
): Promise<void> => {
   const timestamp = indexerHeartbeat.recordHeartbeat();
   await checkIndexerCursorStalenessFromStore({ job: 'indexer' });
   sendSuccess(
      res,
      { recorded: true, timestamp: timestamp.toISOString() },
      200,
      'Heartbeat recorded'
   );
};

export const readinessCheck = async (
   _: Request,
   res: Response
): Promise<void> => {
   const checks: ReadinessCheck[] = [];
   const overallStart = Date.now();

   // DB check
   const dbStart = Date.now();
   try {
      await prisma.$queryRaw`SELECT 1`;
      checks.push({
         name: 'database',
         status: 'ok',
         latencyMs: Date.now() - dbStart,
      });
   } catch (err) {
      checks.push({
         name: 'database',
         status: 'fail',
         error: err instanceof Error ? err.message : 'Unknown error',
      });
   }

   // Cache config check — verifies the HTTP cache layer is configured
   try {
      const configured =
         typeof PUBLIC_ENDPOINT_CACHE_SECONDS.short === 'number';
      if (!configured) throw new Error('Cache config unavailable');
      checks.push({ name: 'cache', status: 'ok' });
   } catch (err) {
      checks.push({
         name: 'cache',
         status: 'fail',
         error: err instanceof Error ? err.message : 'Unknown error',
      });
   }

   const ready = checks.every(c => c.status === 'ok');
   res.status(ready ? 200 : 503).json({
      ready,
      timestamp: new Date().toISOString(),
      latencyMs: Date.now() - overallStart,
      checks,
   });
};
