import request from 'supertest';
import { createServer } from '../../utils/server.utils';
import { prisma } from '../../utils/prisma.utils';
import { processDividendEvents } from '../indexer/dividend-indexer.service';
import { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

describe('Dividend Endpoints Integration Tests', () => {
   let app: any;
   let testCreatorId: string;
   let testDistributionId: string;

   beforeAll(async () => {
      app = await createServer();

      // Clean up
      await prisma.dividendClaim.deleteMany({});
      await prisma.dividendDistribution.deleteMany({});
      await prisma.keyOwnership.deleteMany({});
      await prisma.creatorProfile.deleteMany({});
      await prisma.user.deleteMany({});

      // Create test creator
      const user = await prisma.user.create({
         data: {
            email: `test-${Date.now()}@example.com`,
            passwordHash: 'hash123',
            firstName: 'Test',
            lastName: 'User',
            stellarWallet: { create: { address: 'GBTEST0001' } },
         },
      });

      const creator = await prisma.creatorProfile.create({
         data: {
            userId: user.id,
            handle: `test-creator-${Date.now()}`,
            displayName: 'Test Creator',
         },
      });

      testCreatorId = creator.id;

      // Create test key holders
      const holders = [
         'GHOLDER0000000000000000000000000000000001',
         'GHOLDER0000000000000000000000000000000002',
         'GHOLDER0000000000000000000000000000000003',
      ];

      for (const holder of holders) {
         await prisma.keyOwnership.create({
            data: {
               ownerAddress: holder,
               creatorId: testCreatorId,
               balance: 100,
            },
         });
      }

      // Create test dividend distribution
      const event: IndexerChainEvent = {
         eventType: 'DIVIDEND_DISTRIBUTED',
         creatorId: testCreatorId,
         totalAmountXlm: '300',
         holdersCount: 3,
         distributorAddress: 'GDIST000000000000000000000000000000000001',
         distributedAt: new Date().toISOString(),
         ledger: 12345,
         txHash: 'tx123456789',
         eventIndex: 0,
      };

      await processDividendEvents([event]);

      const dist = await prisma.dividendDistribution.findFirst({
         where: { creatorId: testCreatorId },
      });
      testDistributionId = dist!.id;
   });

   afterAll(async () => {
      await prisma.dividendClaim.deleteMany({});
      await prisma.dividendDistribution.deleteMany({});
      await prisma.keyOwnership.deleteMany({});
      await prisma.creatorProfile.deleteMany({});
      await prisma.user.deleteMany({});
   });

   describe('GET /keys/:keyId/dividends', () => {
      it('should return 200 with dividend distributions', async () => {
         const response = await request(app).get(`/keys/${testCreatorId}/dividends`);

         expect(response.status).toBe(200);
         expect(response.body.success).toBe(true);
         expect(response.body.data).toBeDefined();
         expect(response.body.data.entries).toBeInstanceOf(Array);
      });

      it('AC1: Returns distributions with all required fields', async () => {
         const response = await request(app).get(`/keys/${testCreatorId}/dividends`);

         expect(response.status).toBe(200);
         expect(response.body.data.entries.length).toBeGreaterThan(0);

         const entry = response.body.data.entries[0];
         expect(entry).toHaveProperty('distributionId');
         expect(entry).toHaveProperty('totalAmount');
         expect(entry).toHaveProperty('holderCount');
         expect(entry).toHaveProperty('perKeyAmount');
         expect(entry).toHaveProperty('distributedAt');
      });

      it('AC2: Distributions sorted by distributedAt descending', async () => {
         const response = await request(app).get(`/keys/${testCreatorId}/dividends?limit=10`);

         expect(response.status).toBe(200);
         const entries = response.body.data.entries;

         for (let i = 0; i < entries.length - 1; i++) {
            const current = new Date(entries[i].distributedAt).getTime();
            const next = new Date(entries[i + 1].distributedAt).getTime();
            expect(current).toBeGreaterThanOrEqual(next);
         }
      });

      it('AC3: perKeyAmount computed correctly', async () => {
         const response = await request(app).get(`/keys/${testCreatorId}/dividends`);

         expect(response.status).toBe(200);
         const entries = response.body.data.entries;

         entries.forEach((entry: any) => {
            const computed = entry.totalAmount / entry.holderCount;
            expect(entry.perKeyAmount).toBeCloseTo(computed, 5);
         });
      });

      it('AC4: 404 returned for unknown key ID', async () => {
         const response = await request(app).get(`/keys/unknown-key-id/dividends`);

         expect(response.status).toBe(404);
      });

      it('should support limit parameter', async () => {
         const response = await request(app).get(`/keys/${testCreatorId}/dividends?limit=1`);

         expect(response.status).toBe(200);
         expect(response.body.data.entries.length).toBeLessThanOrEqual(1);
      });

      it('should include pagination metadata', async () => {
         const response = await request(app).get(`/keys/${testCreatorId}/dividends`);

         expect(response.status).toBe(200);
         expect(response.body.data.pagination).toBeDefined();
         expect(response.body.data.pagination).toHaveProperty('limit');
         expect(response.body.data.pagination).toHaveProperty('hasMore');
         expect(response.body.data.pagination).toHaveProperty('nextCursor');
      });

      it('AC5: Cursor pagination works correctly', async () => {
         // First page
         const page1Response = await request(app).get(
            `/keys/${testCreatorId}/dividends?limit=1`
         );

         expect(page1Response.status).toBe(200);
         const page1Entries = page1Response.body.data.entries;
         const nextCursor = page1Response.body.data.pagination.nextCursor;

         if (page1Response.body.data.pagination.hasMore && nextCursor) {
            // Second page
            const page2Response = await request(app).get(
               `/keys/${testCreatorId}/dividends?limit=1&cursor=${nextCursor}`
            );

            expect(page2Response.status).toBe(200);
            const page2Entries = page2Response.body.data.entries;

            expect(page2Entries.length).toBeGreaterThan(0);
            // Verify different entries
            expect(page1Entries[0].distributionId).not.toBe(page2Entries[0].distributionId);
         }
      });

      it('should reject invalid limit', async () => {
         const response = await request(app).get(
            `/keys/${testCreatorId}/dividends?limit=invalid`
         );

         expect(response.status).toBe(400);
      });
   });

   describe('GET /keys/:keyId/dividends/:distributionId/holders', () => {
      it('should return 200 with holder claims', async () => {
         const response = await request(app).get(
            `/keys/${testCreatorId}/dividends/${testDistributionId}/holders`
         );

         expect(response.status).toBe(200);
         expect(response.body.success).toBe(true);
         expect(response.body.data).toBeDefined();
         expect(response.body.data.entries).toBeInstanceOf(Array);
      });

      it('AC4: Per-holder breakdown returns correct payout per wallet', async () => {
         const response = await request(app).get(
            `/keys/${testCreatorId}/dividends/${testDistributionId}/holders`
         );

         expect(response.status).toBe(200);
         const entries = response.body.data.entries;

         expect(entries.length).toBeGreaterThan(0);
         entries.forEach((entry: any) => {
            expect(entry).toHaveProperty('recipientWallet');
            expect(entry).toHaveProperty('amountXlm');
            expect(typeof entry.amountXlm).toBe('number');
            // Each holder has 100 keys, perKeyAmount is 100, so payout should be 10000
            expect(entry.amountXlm).toBe(10000);
         });
      });

      it('AC4: 404 returned for unknown distribution ID', async () => {
         const response = await request(app).get(
            `/keys/${testCreatorId}/dividends/unknown-dist-id/holders`
         );

         expect(response.status).toBe(404);
      });

      it('AC4: 404 returned for distribution not belonging to creator', async () => {
         // Create another creator
         const user = await prisma.user.create({
            data: {
               email: `test2-${Date.now()}@example.com`,

passwordHash: 'hash123',

               firstName: 'Test',
               lastName: 'User',
               stellarWallet: { create: { address: 'GBTEST0002' } },
            },
         });

         const otherCreator = await prisma.creatorProfile.create({
            data: {
               userId: user.id,
               handle: `test-creator2-${Date.now()}`,
               displayName: 'Test Creator 2',
            },
         });

         const response = await request(app).get(
            `/keys/${otherCreator.id}/dividends/${testDistributionId}/holders`
         );

         expect(response.status).toBe(404);
      });

      it('AC5: Cursor pagination works correctly', async () => {
         const page1Response = await request(app).get(
            `/keys/${testCreatorId}/dividends/${testDistributionId}/holders?limit=1`
         );

         expect(page1Response.status).toBe(200);
         const page1Entries = page1Response.body.data.entries;
         const nextCursor = page1Response.body.data.pagination.nextCursor;

         if (page1Response.body.data.pagination.hasMore && nextCursor) {
            const page2Response = await request(app).get(
               `/keys/${testCreatorId}/dividends/${testDistributionId}/holders?limit=1&cursor=${nextCursor}`
            );

            expect(page2Response.status).toBe(200);
            const page2Entries = page2Response.body.data.entries;

            expect(page2Entries.length).toBeGreaterThan(0);
            // Verify different entries
            expect(page1Entries[0].recipientWallet).not.toBe(page2Entries[0].recipientWallet);
         }
      });

      it('should include pagination metadata', async () => {
         const response = await request(app).get(
            `/keys/${testCreatorId}/dividends/${testDistributionId}/holders`
         );

         expect(response.status).toBe(200);
         expect(response.body.data.pagination).toBeDefined();
         expect(response.body.data.pagination).toHaveProperty('limit');
         expect(response.body.data.pagination).toHaveProperty('hasMore');
         expect(response.body.data.pagination).toHaveProperty('nextCursor');
      });

      it('should reject invalid limit', async () => {
         const response = await request(app).get(
            `/keys/${testCreatorId}/dividends/${testDistributionId}/holders?limit=invalid`
         );

         expect(response.status).toBe(400);
      });

      it('should reject negative limit', async () => {
         const response = await request(app).get(
            `/keys/${testCreatorId}/dividends/${testDistributionId}/holders?limit=-5`
         );

         expect(response.status).toBe(400);
      });
   });

   describe('Acceptance Criteria - All Endpoints', () => {
      it('AC1: Distributions listed with all required fields in descending date order', async () => {
         const response = await request(app).get(`/keys/${testCreatorId}/dividends`);

         expect(response.status).toBe(200);
         expect(response.body.data.entries.length).toBeGreaterThan(0);

         const entries = response.body.data.entries;
         entries.forEach((entry: any) => {
            expect(entry.distributionId).toBeDefined();
            expect(entry.totalAmount).toBeDefined();
            expect(entry.holderCount).toBeDefined();
            expect(entry.perKeyAmount).toBeDefined();
            expect(entry.distributedAt).toBeDefined();
         });

         // Verify descending order
         for (let i = 0; i < entries.length - 1; i++) {
            expect(new Date(entries[i].distributedAt).getTime()).toBeGreaterThanOrEqual(
               new Date(entries[i + 1].distributedAt).getTime()
            );
         }
      });

      it('AC2: perKeyAmount computed correctly as totalAmount / holderCount', async () => {
         const response = await request(app).get(`/keys/${testCreatorId}/dividends`);

         expect(response.status).toBe(200);
         const entries = response.body.data.entries;

         entries.forEach((entry: any) => {
            const computed = entry.totalAmount / entry.holderCount;
            expect(entry.perKeyAmount).toBeCloseTo(computed, 5);
         });
      });

      it('AC3: Per-holder breakdown endpoint returns correct payout per wallet', async () => {
         const response = await request(app).get(
            `/keys/${testCreatorId}/dividends/${testDistributionId}/holders`
         );

         expect(response.status).toBe(200);
         const entries = response.body.data.entries;

         entries.forEach((entry: any) => {
            expect(entry.recipientWallet).toBeDefined();
            expect(entry.amountXlm).toBeDefined();
            expect(Number.isFinite(entry.amountXlm)).toBe(true);
         });
      });

      it('AC4: 404 returned for unknown key ID or distribution ID', async () => {
         const keyResponse = await request(app).get(`/keys/unknown-key/dividends`);
         expect(keyResponse.status).toBe(404);

         const distResponse = await request(app).get(
            `/keys/${testCreatorId}/dividends/unknown-dist/holders`
         );
         expect(distResponse.status).toBe(404);
      });

      it('AC5: Cursor pagination works correctly on both endpoints', async () => {
         // Test distributions endpoint
         const distPage1 = await request(app).get(`/keys/${testCreatorId}/dividends?limit=1`);
         expect(distPage1.status).toBe(200);

         if (distPage1.body.data.pagination.hasMore) {
            const distPage2 = await request(app).get(
               `/keys/${testCreatorId}/dividends?limit=1&cursor=${distPage1.body.data.pagination.nextCursor}`
            );
            expect(distPage2.status).toBe(200);
            expect(distPage1.body.data.entries[0].distributionId).not.toBe(
               distPage2.body.data.entries[0].distributionId
            );
         }

         // Test holders endpoint
         const holdersPage1 = await request(app).get(
            `/keys/${testCreatorId}/dividends/${testDistributionId}/holders?limit=1`
         );
         expect(holdersPage1.status).toBe(200);

         if (holdersPage1.body.data.pagination.hasMore) {
            const holdersPage2 = await request(app).get(
               `/keys/${testCreatorId}/dividends/${testDistributionId}/holders?limit=1&cursor=${holdersPage1.body.data.pagination.nextCursor}`
            );
            expect(holdersPage2.status).toBe(200);
            expect(holdersPage1.body.data.entries[0].recipientWallet).not.toBe(
               holdersPage2.body.data.entries[0].recipientWallet
            );
         }
      });
   });
});
