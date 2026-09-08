// Isolated integration test for health endpoint response time.
// Run alone to avoid interference from concurrent test activity:
//   pnpm exec jest src/modules/health/health.response-time.integration.test.ts

jest.mock('../../config', () => ({
   envConfig: {
      MODE: 'test',
      PORT: 3000,
      INDEXER_HEARTBEAT_STALE_THRESHOLD_MS: 300000,
   },
   appConfig: {
      allowedOrigins: [],
   },
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      $queryRaw: jest.fn(),
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   getRedisClient: jest.fn(() => ({
      ping: jest.fn().mockResolvedValue('PONG'),
   })),
}));

jest.mock('../../clients/horizon.client', () => ({
   horizonGet: jest.fn().mockResolvedValue({ ok: true }),
}));

import { Request, Response } from 'express';
import { simpleHealthCheck } from './health.controllers';
import { HEALTH_LIVENESS_MAX_LATENCY_MS } from '../../constants/health.constants';
import { elapsedMs, startTimer } from '../../utils/monotonic-clock.utils';
import { prisma } from '../../utils/prisma.utils';

const queryRawMock = prisma.$queryRaw as unknown as jest.Mock;

function mockResponse(): Response & { statusCode: number; body: unknown } {
   const res = { statusCode: 0, body: undefined as unknown } as Response & {
      statusCode: number;
      body: unknown;
   };
   res.status = (code: number) => {
      res.statusCode = code;
      return res;
   };
   res.json = (payload: unknown) => {
      res.body = payload;
      return res;
   };
   return res;
}

describe('simpleHealthCheck() — response time budget', () => {
   it(`responds within ${HEALTH_LIVENESS_MAX_LATENCY_MS}ms`, async () => {
      queryRawMock.mockResolvedValue([{ '?column?': 1 }]);
      const timer = startTimer();
      const res = mockResponse();

      await simpleHealthCheck({} as Request, res);

      const durationMs = elapsedMs(timer);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual(
         expect.objectContaining({ success: true, checks: expect.any(Array) })
      );
      expect(durationMs).toBeLessThanOrEqual(HEALTH_LIVENESS_MAX_LATENCY_MS);
   });
});
