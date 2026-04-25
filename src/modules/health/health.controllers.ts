import { Request, Response } from 'express';
import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';
import { indexerHeartbeat } from '../../utils/heartbeat.service';
import { sendSuccess } from '../../utils/api-response.utils';

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
      services: [
        {
          name: 'API Server',
          status: 'healthy',
        },
        {
          name: 'Database',
          status: dbStatus.status === 'connected' ? 'healthy' : 'unhealthy',
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
export const recordIndexerHeartbeat = (_: Request, res: Response): void => {
  const timestamp = indexerHeartbeat.recordHeartbeat();
  sendSuccess(
    res,
    { recorded: true, timestamp: timestamp.toISOString() },
    200,
    'Heartbeat recorded'
  );
};

