jest.unmock('@prisma/client');
jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn().mockResolvedValue(null), cacheSetJson: jest.fn(),
   cacheInvalidate: jest.fn(),
}));
import express from 'express';
import request from 'supertest';
import { prisma } from '../../utils/prisma.utils';
import { processPolEvents } from './pol-indexer.service';
import { protocolPolRouter, keyBackstopsRouter } from './pol.routes';

const suite = process.env.RUN_POL_INTEGRATION === '1' ? describe : describe.skip;
suite('POL funding, backstop, repayment HTTP lifecycle', () => {
   const app = express();
   app.use('/api/v1/protocol', protocolPolRouter);
   app.use('/api/v1/keys', keyBackstopsRouter);
   const event = (type: string, index: number, amount: string) => ({
      eventType: type, txHash: 'pol-integration-receipts', eventIndex: index,
      ledger: 100 + index, keyId: 'pol-integration-key', amount,
      timestamp: '2026-11-21T00:00:00Z',
   });
   beforeAll(async () => {
      await prisma.backstop.deleteMany();
      await prisma.polReserve.deleteMany();
   });
   afterAll(async () => {
      await prisma.backstop.deleteMany({ where: { txHash: 'pol-integration-receipts' } });
      await prisma.polReserve.deleteMany({ where: { id: 'default' } });
      await prisma.$disconnect();
   });
   it('keeps balances exact across all transitions and replay', async () => {
      const funding = event('pol_funded', 0, '100');
      const applied = event('backstop_applied', 1, '20');
      const repaid = event('backstop_repaid', 2, '5');
      await processPolEvents([funding, applied, repaid]);
      await processPolEvents([funding, applied, repaid]);
      const summary = await request(app).get('/api/v1/protocol/pol');
      expect(summary.status).toBe(200);
      expect(summary.body.data).toEqual({ balance: '85', deployedAmount: '20', repaidAmount: '5' });
      const history = await request(app).get('/api/v1/keys/pol-integration-key/backstops');
      expect(history.status).toBe(200);
      expect(history.body.data.outstandingAmount).toBe('15');
      expect(history.body.data.repaymentStatus).toBe('partial');
      expect(history.body.data.items.map((row: { type: string }) => row.type)).toEqual(['repaid', 'applied']);
      expect(await prisma.backstop.count({ where: { txHash: funding.txHash } })).toBe(3);
   });
   it('concurrent replays cannot double-count a new event', async () => {
      const repay = event('backstop_repaid', 3, '15');
      await Promise.all([processPolEvents([repay]), processPolEvents([repay])]);
      const result = await request(app).get('/api/v1/keys/pol-integration-key/backstops');
      expect(result.body.data.outstandingAmount).toBe('0');
      expect(result.body.data.repaymentStatus).toBe('repaid');
   });
   it('returns zeros for an untouched key and rejects malformed pagination', async () => {
      const empty = await request(app).get('/api/v1/keys/no-pol-backstops/backstops');
      expect(empty.body.data.items).toEqual([]);
      expect(empty.body.data.outstandingAmount).toBe('0');
      expect((await request(app).get('/api/v1/keys/key/backstops?limit=0')).status).toBe(400);
      expect((await request(app).get('/api/v1/keys/key/backstops?limit=101')).status).toBe(400);
      expect((await request(app).get('/api/v1/keys/key/backstops?offset=-1')).status).toBe(400);
   });
});
