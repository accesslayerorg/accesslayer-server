import request from 'supertest';
import { createServer } from '../../utils/server.utils';
import { prisma } from '../../utils/prisma.utils';
import jwt from 'jsonwebtoken';
import { envConfig } from '../../config';
import { processLpAllocationEvents } from './lp-allocation-indexer.service';
import { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';
import { cacheGetJson } from '../../utils/redis.utils';
import { getKeyLpStatsCacheKey } from '../keys/key-lp.service';
import { LP_OVERVIEW_CACHE_KEY } from '../admin/lp-overview.service';

function adminToken(): string {
   return jwt.sign(
      { sub: 'admin-test', role: 'admin' },
      envConfig.JWT_SECRET,
      { expiresIn: '1h' }
   );
}

function lpEvent(
   overrides: Partial<IndexerChainEvent> & { creatorId: string }
): IndexerChainEvent {
   return {
      eventType: 'LP_ALLOCATION_SENT',
      amountXlm: '100',
      allocatedAt: new Date().toISOString(),
      ledger: 1000,
      txHash: `tx-${Math.random().toString(36).slice(2)}`,
      eventIndex: 0,
      ...overrides,
   } as IndexerChainEvent;
}

describe('LP allocation tracking and TVL reporting (#943)', () => {
   let app: any;
   let creatorAId: string;
   let creatorBId: string;

   beforeAll(async () => {
      app = await createServer();
   });

   beforeEach(async () => {
      await prisma.lpAllocation.deleteMany({});
      await prisma.creatorProfile.deleteMany({});
      await prisma.user.deleteMany({});

      const userA = await prisma.user.create({
         data: {
            email: `lp-test-a-${Date.now()}@example.com`,
            passwordHash: 'hash123',
            firstName: 'A',
            lastName: 'Creator',
         },
      });
      const creatorA = await prisma.creatorProfile.create({
         data: {
            userId: userA.id,
            handle: `lp-creator-a-${Date.now()}`,
            displayName: 'Creator A',
         },
      });
      creatorAId = creatorA.id;

      const userB = await prisma.user.create({
         data: {
            email: `lp-test-b-${Date.now()}@example.com`,
            passwordHash: 'hash123',
            firstName: 'B',
            lastName: 'Creator',
         },
      });
      const creatorB = await prisma.creatorProfile.create({
         data: {
            userId: userB.id,
            handle: `lp-creator-b-${Date.now()}`,
            displayName: 'Creator B',
         },
      });
      creatorBId = creatorB.id;
   });

   afterAll(async () => {
      await prisma.lpAllocation.deleteMany({});
   });

   it('AC1: records LP allocations correctly from contract events', async () => {
      const event = lpEvent({ creatorId: creatorAId, amountXlm: '50' });
      await processLpAllocationEvents([event]);

      const rows = await prisma.lpAllocation.findMany({
         where: { creatorId: creatorAId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].amountXlm.toString()).toBe('50.0000000');
      expect(rows[0].txHash).toBe(event.txHash);
   });

   it('AC1: is idempotent on replay of the same txHash + eventIndex', async () => {
      const event = lpEvent({
         creatorId: creatorAId,
         amountXlm: '50',
         txHash: 'tx-fixed-1',
         eventIndex: 2,
      });
      await processLpAllocationEvents([event]);
      await processLpAllocationEvents([event]);

      const rows = await prisma.lpAllocation.findMany({
         where: { creatorId: creatorAId },
      });
      expect(rows).toHaveLength(1);
   });

   it('AC1: skips events missing required fields', async () => {
      const badEvent = {
         eventType: 'LP_ALLOCATION_SENT',
         creatorId: creatorAId,
         // amountXlm missing
         allocatedAt: new Date().toISOString(),
         ledger: 1000,
         txHash: 'tx-missing-field',
         eventIndex: 0,
      } as unknown as IndexerChainEvent;

      await processLpAllocationEvents([badEvent]);

      const rows = await prisma.lpAllocation.findMany({
         where: { creatorId: creatorAId },
      });
      expect(rows).toHaveLength(0);
   });

   it('AC2: GET /keys/:id/lp-stats returns correct cumulative amounts', async () => {
      await processLpAllocationEvents([
         lpEvent({ creatorId: creatorAId, amountXlm: '100', txHash: 'tx-a1' }),
         lpEvent({ creatorId: creatorAId, amountXlm: '25.5', txHash: 'tx-a2' }),
      ]);

      const res = await request(app).get(`/api/v1/keys/${creatorAId}/lp-stats`);

      expect(res.status).toBe(200);
      expect(res.body.data.keyId).toBe(creatorAId);
      expect(res.body.data.totalLpContributedXlm).toBe('125.5000000');
      expect(res.body.data.currentLpBalanceXlm).toBe('125.5000000');
      expect(res.body.data.allocationCount).toBe(2);
   });

   it('AC2: 404 for an unknown key', async () => {
      const res = await request(app).get('/api/v1/keys/does-not-exist/lp-stats');
      expect(res.status).toBe(404);
   });

   it('AC3: GET /admin/lp-overview aggregates LP correctly across all keys', async () => {
      await processLpAllocationEvents([
         lpEvent({ creatorId: creatorAId, amountXlm: '100', txHash: 'tx-ov1' }),
         lpEvent({ creatorId: creatorBId, amountXlm: '200', txHash: 'tx-ov2' }),
      ]);

      const res = await request(app)
         .get('/api/v1/admin/lp-overview')
         .set('Authorization', `Bearer ${adminToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.data.totalProtocolLpXlm).toBe('300.0000000');
      expect(res.body.data.keyCount).toBe(2);
      expect(res.body.data.allocationCount).toBe(2);
   });

   it('AC3: 403 for admin overview without an admin token', async () => {
      const res = await request(app).get('/api/v1/admin/lp-overview');
      expect([401, 403]).toContain(res.status);
   });

   it('AC4: cache is invalidated on a new LPAllocationSent event', async () => {
      await processLpAllocationEvents([
         lpEvent({ creatorId: creatorAId, amountXlm: '10', txHash: 'tx-c1' }),
      ]);

      const first = await request(app).get(
         `/api/v1/keys/${creatorAId}/lp-stats`
      );
      expect(first.body.data.totalLpContributedXlm).toBe('10.0000000');

      // Stats are now cached for the key.
      const cachedBefore = await cacheGetJson(getKeyLpStatsCacheKey(creatorAId));
      expect(cachedBefore).not.toBeNull();

      await processLpAllocationEvents([
         lpEvent({ creatorId: creatorAId, amountXlm: '15', txHash: 'tx-c2' }),
      ]);

      // The new event must have invalidated the stale cache entry.
      const cachedAfter = await cacheGetJson(getKeyLpStatsCacheKey(creatorAId));
      expect(cachedAfter).toBeNull();

      const second = await request(app).get(
         `/api/v1/keys/${creatorAId}/lp-stats`
      );
      expect(second.body.data.totalLpContributedXlm).toBe('25.0000000');
   });

   it('AC4: admin overview cache is invalidated on a new event', async () => {
      await processLpAllocationEvents([
         lpEvent({ creatorId: creatorAId, amountXlm: '10', txHash: 'tx-d1' }),
      ]);
      await request(app)
         .get('/api/v1/admin/lp-overview')
         .set('Authorization', `Bearer ${adminToken()}`);

      const cachedBefore = await cacheGetJson(LP_OVERVIEW_CACHE_KEY);
      expect(cachedBefore).not.toBeNull();

      await processLpAllocationEvents([
         lpEvent({ creatorId: creatorBId, amountXlm: '5', txHash: 'tx-d2' }),
      ]);

      const cachedAfter = await cacheGetJson(LP_OVERVIEW_CACHE_KEY);
      expect(cachedAfter).toBeNull();
   });

   it('AC5: GET /keys/:id/lp-history paginates correctly with a cursor', async () => {
      await processLpAllocationEvents([
         lpEvent({
            creatorId: creatorAId,
            amountXlm: '1',
            txHash: 'tx-p1',
            allocatedAt: new Date('2024-01-01T00:00:00Z').toISOString(),
         }),
         lpEvent({
            creatorId: creatorAId,
            amountXlm: '2',
            txHash: 'tx-p2',
            allocatedAt: new Date('2024-01-02T00:00:00Z').toISOString(),
         }),
         lpEvent({
            creatorId: creatorAId,
            amountXlm: '3',
            txHash: 'tx-p3',
            allocatedAt: new Date('2024-01-03T00:00:00Z').toISOString(),
         }),
      ]);

      const firstPage = await request(app).get(
         `/api/v1/keys/${creatorAId}/lp-history?limit=2`
      );
      expect(firstPage.status).toBe(200);
      expect(firstPage.body.data.entries).toHaveLength(2);
      // Newest first.
      expect(firstPage.body.data.entries[0].txHash).toBe('tx-p3');
      expect(firstPage.body.data.entries[1].txHash).toBe('tx-p2');
      expect(firstPage.body.data.pagination.hasMore).toBe(true);
      const cursor = firstPage.body.data.pagination.nextCursor;
      expect(typeof cursor).toBe('string');

      const secondPage = await request(app).get(
         `/api/v1/keys/${creatorAId}/lp-history?limit=2&cursor=${cursor}`
      );
      expect(secondPage.status).toBe(200);
      expect(secondPage.body.data.entries).toHaveLength(1);
      expect(secondPage.body.data.entries[0].txHash).toBe('tx-p1');
      expect(secondPage.body.data.pagination.hasMore).toBe(false);
   });

   it('AC5: 404 for lp-history on an unknown key', async () => {
      const res = await request(app).get(
         '/api/v1/keys/does-not-exist/lp-history'
      );
      expect(res.status).toBe(404);
   });
});
