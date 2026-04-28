import { Request, Response } from 'express';

jest.mock('../../config', () => ({
   envConfig: { MODE: 'test', PORT: 3000 },
   appConfig: { allowedOrigins: [] },
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      $queryRaw: jest.fn(),
   },
}));

import { readinessCheck } from './health.controllers';
import { prisma } from '../../utils/prisma.utils';

const queryRawMock = prisma.$queryRaw as unknown as jest.Mock;

function buildRes() {
   const res = {
      statusCode: 0,
      body: undefined as unknown,
      status(code: number) {
         this.statusCode = code;
         return this;
      },
      json(payload: unknown) {
         this.body = payload;
         return this;
      },
   };
   return res as unknown as Response & { statusCode: number; body: any };
}

describe('readinessCheck()', () => {
   beforeEach(() => {
      queryRawMock.mockReset();
   });

   it('includes a top-level latencyMs field in the response metadata', async () => {
      queryRawMock.mockResolvedValue([{ '?column?': 1 }]);
      const res = buildRes();

      await readinessCheck({} as Request, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.ready).toBe(true);
      expect(typeof res.body.latencyMs).toBe('number');
      expect(res.body.latencyMs).toBeGreaterThanOrEqual(0);
   });

   it('still reports latencyMs when a check fails (returns 503)', async () => {
      queryRawMock.mockRejectedValue(new Error('connection refused'));
      const res = buildRes();

      await readinessCheck({} as Request, res);

      expect(res.statusCode).toBe(503);
      expect(res.body.ready).toBe(false);
      expect(typeof res.body.latencyMs).toBe('number');
   });

   it('keeps the existing per-check latencyMs alongside the new top-level field', async () => {
      queryRawMock.mockResolvedValue([{ '?column?': 1 }]);
      const res = buildRes();

      await readinessCheck({} as Request, res);

      const dbCheck = res.body.checks.find((c: any) => c.name === 'database');
      expect(dbCheck.status).toBe('ok');
      expect(typeof dbCheck.latencyMs).toBe('number');
      expect(typeof res.body.latencyMs).toBe('number');
   });
});
