// src/modules/protocol/fee-change.routes.test.ts

import express from 'express';
import request from 'supertest';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      protocolConfig: { findUnique: jest.fn() },
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(),
   cacheSetJson: jest.fn(),
   cacheInvalidate: jest.fn(),
}));

jest.mock('./fee-change.service', () => ({
   getProtocolFeesState: jest.fn(),
   getProtocolFeesHistory: jest.fn(),
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

import protocolRouter from './protocol.routes';
import {
   getProtocolFeesState,
   getProtocolFeesHistory,
} from './fee-change.service';

describe('protocol fee routes', () => {
   const app = express();
   app.use(express.json());
   app.use('/v1/protocol', protocolRouter);

   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('GET /v1/protocol/fees returns current and pending fee config', async () => {
      (getProtocolFeesState as jest.Mock).mockResolvedValue({
         current: { protocolFeeBps: 500, effectiveLedger: 100 },
         pending: {
            changeId: 'chg-1',
            protocolFeeBps: 350,
            executeAfterLedger: 2000,
            estimatedExecuteAt: '2026-11-24T13:23:20.000Z',
         },
      });

      const res = await request(app).get('/v1/protocol/fees');
      expect(res.status).toBe(200);
      expect(res.body.data.current.protocolFeeBps).toBe(500);
      expect(res.body.data.pending.executeAfterLedger).toBe(2000);
   });

   it('GET /v1/protocol/fees/history?cursor= returns paginated history', async () => {
      (getProtocolFeesHistory as jest.Mock).mockResolvedValue({
         items: [{ id: 'h-2', protocolFeeBps: 400, effectiveLedger: 500 }],
         nextCursor: 'h-2',
      });

      const res = await request(app).get('/v1/protocol/fees/history?cursor=h-3');
      expect(res.status).toBe(200);
      expect(getProtocolFeesHistory).toHaveBeenCalledWith({
         cursor: 'h-3',
         limit: undefined,
      });
      expect(res.body.data.nextCursor).toBe('h-2');
   });
});
