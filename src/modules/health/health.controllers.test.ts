import { Request, Response } from 'express';
import { healthCheck, simpleHealthCheck, readinessCheck } from './health.controllers';
import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';
import { DEFAULT_RPC_TIMEOUT_MS } from '../../utils/rpc-timeout.utils';

// Mock dependencies
jest.mock('../../utils/prisma.utils');
jest.mock('../../config');

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockEnvConfig = envConfig as jest.Mocked<typeof envConfig>;

describe('Health Controllers', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;

  beforeEach(() => {
    mockJson = jest.fn();
    mockStatus = jest.fn().mockReturnThis();
    mockRequest = {};
    mockResponse = {
      json: mockJson,
      status: mockStatus,
    };
    
    // Reset mocks
    jest.clearAllMocks();
    
    // Default env config
    mockEnvConfig.MODE = 'test';
    mockEnvConfig.BACKGROUND_JOB_LOCK_TTL_MS = 300000;
    mockEnvConfig.CREATOR_LIST_SLOW_QUERY_THRESHOLD_MS = 500;
  });

  describe('simpleHealthCheck', () => {
    it('should return simple health status', () => {
      simpleHealthCheck(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(200);
      expect(mockJson).toHaveBeenCalledWith({
        success: true,
        message: 'OK',
        timestamp: expect.any(String),
      });
    });
  });

  describe('readinessCheck', () => {
    it('should return ready status when all checks pass', async () => {
      mockPrisma.$queryRaw.mockResolvedValue(undefined);

      await readinessCheck(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(200);
      expect(mockJson).toHaveBeenCalledWith({
        ready: true,
        timestamp: expect.any(String),
        checks: [
          { name: 'database', status: 'ok', latencyMs: expect.any(Number) },
          { name: 'cache', status: 'ok' },
        ],
      });
    });

    it('should return not ready when database check fails', async () => {
      mockPrisma.$queryRaw.mockRejectedValue(new Error('DB connection failed'));

      await readinessCheck(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(503);
      expect(mockJson).toHaveBeenCalledWith({
        ready: false,
        timestamp: expect.any(String),
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: 'database',
            status: 'fail',
            error: 'DB connection failed',
          }),
        ]),
      });
    });
  });

  describe('healthCheck', () => {
    beforeEach(() => {
      mockPrisma.$queryRaw.mockResolvedValue(undefined);
    });

    it('should return detailed health status with timeout metadata', async () => {
      await healthCheck(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(200);
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: 'Access Layer server is running',
          timestamp: expect.any(String),
          version: '1.0.0',
          environment: 'test',
          uptime: expect.any(Number),
          memory: expect.objectContaining({
            used: expect.any(Number),
            total: expect.any(Number),
          }),
          system: expect.objectContaining({
            platform: expect.any(String),
            nodeVersion: expect.any(String),
          }),
          database: expect.objectContaining({
            status: 'connected',
            responseTime: expect.any(Number),
          }),
          syncing: expect.any(Object),
          services: expect.arrayContaining([
            { name: 'API Server', status: 'healthy' },
            { name: 'Database', status: 'healthy' },
            { name: 'Chain Sync', status: 'healthy' },
          ]),
          timeouts: expect.objectContaining({
            rpc: expect.any(Number),
            backgroundJob: expect.any(Number),
            slowQueryThreshold: expect.any(Number),
            shutdown: expect.any(Number),
          }),
        })
      );
    });

    it('should include exact timeout values in development', async () => {
      mockEnvConfig.MODE = 'development';
      
      await healthCheck(mockRequest as Request, mockResponse as Response);

      const healthData = mockJson.mock.calls[0][0];
      expect(healthData.timeouts).toEqual({
        rpc: DEFAULT_RPC_TIMEOUT_MS,
        backgroundJob: mockEnvConfig.BACKGROUND_JOB_LOCK_TTL_MS,
        slowQueryThreshold: mockEnvConfig.CREATOR_LIST_SLOW_QUERY_THRESHOLD_MS,
        shutdown: 30000,
      });
    });

    it('should include sanitized timeout values in production', async () => {
      mockEnvConfig.MODE = 'production';
      
      await healthCheck(mockRequest as Request, mockResponse as Response);

      const healthData = mockJson.mock.calls[0][0];
      expect(healthData.timeouts.rpc).toBe(Math.round(DEFAULT_RPC_TIMEOUT_MS / 1000) * 1000);
      expect(healthData.timeouts.backgroundJob).toBe(
        Math.round(mockEnvConfig.BACKGROUND_JOB_LOCK_TTL_MS / 60000) * 60000
      );
      expect(healthData.timeouts.slowQueryThreshold).toBe(
        Math.round(mockEnvConfig.CREATOR_LIST_SLOW_QUERY_THRESHOLD_MS / 100) * 100
      );
      expect(healthData.timeouts.shutdown).toBe(30000); // Already rounded
    });

    it('should return 503 when database is disconnected in production', async () => {
      mockEnvConfig.MODE = 'production';
      mockPrisma.$queryRaw.mockRejectedValue(new Error('DB connection failed'));

      await healthCheck(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(503);
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          database: { status: 'disconnected' },
          services: expect.arrayContaining([
            { name: 'Database', status: 'unhealthy' },
          ]),
        })
      );
    });

    it('should return 200 when database is disconnected in development', async () => {
      mockEnvConfig.MODE = 'development';
      mockPrisma.$queryRaw.mockRejectedValue(new Error('DB connection failed'));

      await healthCheck(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(200);
    });

    it('should handle health check errors gracefully', async () => {
      mockPrisma.$queryRaw.mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      await healthCheck(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith({
        success: false,
        message: 'Health check failed',
        error: 'Unexpected error',
      });
    });
  });
});
