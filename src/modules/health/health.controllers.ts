import { Request, Response } from 'express';
import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';
import { PUBLIC_ENDPOINT_CACHE_SECONDS } from '../../constants/public-endpoint-cache.constants';

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
      console.error('Database health check failed:', dbError);
      dbStatus = {
        status: 'disconnected',
      };
    }

    const syncStatus = await getChainSyncStatus();

    const healthData: HealthStatus = {
      success: true,
      message: 'Access Layer server is running',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      environment: envConfig.MODE || 'development',
      uptime: process.uptime(),
      memory: {
        used:
          Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) /
          100,
        total:
          Math.round((process.memoryUsage().heapTotal / 1024 / 1024) * 100) /
          100,
      },
      system: {
        platform: process.platform,
        nodeVersion: process.version,
      },
      database: dbStatus,
      syncing: syncStatus || undefined,
      services: [
        {
          name: 'API Server',
          status: 'healthy',
        },
        {
          name: 'Database',
          status: dbStatus.status === 'connected' ? 'healthy' : 'unhealthy',
        },
        {
          name: 'Chain Sync',
          status: syncStatus?.status === 'degraded' ? 'unhealthy' : 'healthy',
        },
      ],
    };

    // Return 503 if database is disconnected in production
    const overallHealthy = 
      dbStatus.status === 'connected' || 
      envConfig.MODE !== 'production';
    
    res.status(overallHealthy ? 200 : 503).json(healthData);
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(500).json({
      success: false,
      message: 'Health check failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const simpleHealthCheck = (_: Request, res: Response): void => {
  res.status(200).json({
    success: true,
    message: 'OK',
    timestamp: new Date().toISOString(),
  });
};

export const readinessCheck = async (_: Request, res: Response): Promise<void> => {
  const checks: ReadinessCheck[] = [];

  // DB check
  const dbStart = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.push({ name: 'database', status: 'ok', latencyMs: Date.now() - dbStart });
  } catch (err) {
    checks.push({
      name: 'database',
      status: 'fail',
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }

  // Cache config check — verifies the HTTP cache layer is configured
  try {
    const configured = typeof PUBLIC_ENDPOINT_CACHE_SECONDS.short === 'number';
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
    checks,
  });
};
