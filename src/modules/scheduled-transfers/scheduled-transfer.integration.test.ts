// Exercises the indexer and HTTP read model against PostgreSQL.
jest.unmock('@prisma/client');
jest.mock('../../clients/horizon.client', () => ({ horizonGet: jest.fn() }));

import express from 'express';
import request from 'supertest';
import { horizonGet } from '../../clients/horizon.client';
import { prisma } from '../../utils/prisma.utils';
import { processScheduledTransferEvent } from '../indexer/scheduled-transfer-indexer.service';
import router from './scheduled-transfer.routes';

const ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const prefix = 'scheduled-transfer-integration-';
const app = express();
app.use('/api/v1/wallets', router);

const schedule = (id: string, releaseLedger = 100) => ({
   eventType: 'transfer_scheduled', transferId: prefix + id,
   txHash: prefix + 'schedule-' + id, eventIndex: 0, ledger: 80,
   sender: ADDRESS, recipient: OTHER, keyId: prefix + 'key', amount: '42',
   releaseLedger, timestamp: '2026-11-21T00:00:00Z',
});
const finish = (id: string, eventType: string) => ({
   eventType, transferId: prefix + id, txHash: prefix + eventType + '-' + id,
   eventIndex: 0, ledger: 100, timestamp: '2026-11-21T00:01:00Z',
});
async function clean() {
   await prisma.scheduledTransferEvent.deleteMany({ where: { transferId: { startsWith: prefix } } });
   await prisma.scheduledTransfer.deleteMany({ where: { id: { startsWith: prefix } } });
}
const describeDatabase = process.env.RUN_SCHEDULED_TRANSFER_INTEGRATION === '1' ? describe : describe.skip;

describeDatabase('scheduled transfer database and HTTP lifecycle', () => {
   beforeEach(async () => {
      await clean();
      (horizonGet as jest.Mock).mockResolvedValue({
         ok: true,
         json: async () => ({ _embedded: { records: [
            { sequence: 100, closed_at: '2026-11-21T00:01:00Z' },
            { sequence: 99, closed_at: '2026-11-21T00:00:55Z' },
         ] } }),
      });
   });
   afterAll(async () => {
      await clean();
      await prisma.$disconnect();
   });

   it('reflects scheduling, claims, cancellation and replays through the wallet API', async () => {
      await processScheduledTransferEvent(schedule('pending', 101));
      await processScheduledTransferEvent(schedule('claim'));
      await processScheduledTransferEvent(schedule('cancel'));
      await processScheduledTransferEvent(finish('claim', 'transfer_claimed'));
      await processScheduledTransferEvent(finish('cancel', 'transfer_cancelled'));
      await processScheduledTransferEvent(schedule('claim'));

      const outgoing = await request(app).get(`/api/v1/wallets/${ADDRESS}/scheduled-transfers?direction=outgoing`);
      expect(outgoing.status).toBe(200);
      expect(outgoing.body.data.items).toHaveLength(3);
      const statuses = Object.fromEntries(outgoing.body.data.items.map((item: { id: string; status: string }) => [item.id, item.status]));
      expect(statuses).toEqual({
         [prefix + 'pending']: 'pending', [prefix + 'claim']: 'claimed', [prefix + 'cancel']: 'cancelled',
      });
      expect(outgoing.body.data.items.every((item: { claimable: boolean }) => !item.claimable)).toBe(true);
      expect(await prisma.scheduledTransferEvent.count({ where: { transferId: { startsWith: prefix } } })).toBe(5);

      const incoming = await request(app).get(`/api/v1/wallets/${OTHER}/scheduled-transfers?direction=incoming`);
      expect(incoming.body.data.items).toHaveLength(3);
      const wrongSide = await request(app).get(`/api/v1/wallets/${ADDRESS}/scheduled-transfers?direction=incoming`);
      expect(wrongSide.body.data.items).toEqual([]);
   });

   it('changes claimability at the release ledger without a new transfer event', async () => {
      await processScheduledTransferEvent(schedule('boundary', 100));
      const response = await request(app).get(`/api/v1/wallets/${OTHER}/scheduled-transfers`);
      expect(response.body.data.items[0].claimable).toBe(true);
   });

   it('serializes concurrent terminal-before-schedule delivery and duplicate events', async () => {
      await Promise.all([
         processScheduledTransferEvent(finish('race', 'transfer_claimed')),
         processScheduledTransferEvent(schedule('race')),
         processScheduledTransferEvent(schedule('race')),
      ]);
      expect(await prisma.scheduledTransfer.count({ where: { id: prefix + 'race' } })).toBe(1);
      expect((await prisma.scheduledTransfer.findUnique({ where: { id: prefix + 'race' } }))?.status).toBe('claimed');
   });

   it('paginates with tied scheduling ledgers without losing rows', async () => {
      await processScheduledTransferEvent(schedule('one'));
      await processScheduledTransferEvent(schedule('two'));
      const first = await request(app).get(`/api/v1/wallets/${ADDRESS}/scheduled-transfers?limit=1`);
      const second = await request(app).get(`/api/v1/wallets/${ADDRESS}/scheduled-transfers?limit=1&cursor=${first.body.data.meta.nextCursor}`);
      expect(first.body.data.items[0].id).not.toBe(second.body.data.items[0].id);
      expect(second.body.data.meta.hasNextPage).toBe(false);
   });
});
