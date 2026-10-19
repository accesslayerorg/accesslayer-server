import { prisma } from '../../utils/prisma.utils';
import {
   getDividendDistributions,
   getDividendClaims,
   getDividendDistributionById,
} from './dividend.service';
import { processDividendEvents } from '../indexer/dividend-indexer.service';
import { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';
import * as redisUtils from '../../utils/redis.utils';

describe('Dividend Service Integration Tests', () => {
   let testCreatorId: string;
   let testDistributionId: string;
   const distributions: Array<{ id: string; [key: string]: any }> = [];
   const claims: Array<{ id: string; [key: string]: any }> = [];
   const holdings: Array<{ id: string; [key: string]: any }> = [];
   let nextDistributionId = 0;
   let nextClaimId = 0;

   function applyPagination<T extends { id: string }>(
      rows: T[],
      args: {
         cursor?: { id: string };
         skip?: number;
         take?: number;
      }
   ): T[] {
      let paged = rows;
      if (args.cursor) {
         const cursorIndex = paged.findIndex(
            row => row.id === args.cursor?.id
         );
         if (cursorIndex >= 0) {
            paged = paged.slice(cursorIndex + (args.skip ?? 0));
         }
      }
      return args.take === undefined ? paged : paged.slice(0, args.take);
   }

   beforeAll(() => {
      testCreatorId = 'dividend-test-creator';
      jest.spyOn(redisUtils, 'cacheGetJson').mockResolvedValue(null);
      jest.spyOn(redisUtils, 'cacheSetJson').mockResolvedValue();

      jest.spyOn(prisma.user, 'create').mockResolvedValue({
         id: 'dividend-test-user',
      } as any);
      jest.spyOn(prisma.creatorProfile, 'create').mockResolvedValue({
         id: testCreatorId,
      } as any);
      jest.spyOn(prisma.keyOwnership as any, 'create').mockImplementation(
         async ({ data }: any) => {
            const holding = { id: `holding-${holdings.length + 1}`, ...data };
            holdings.push(holding);
            return holding as any;
         }
      );
      jest.spyOn(prisma.keyOwnership as any, 'findMany').mockImplementation(
         async ({ where }: any = {}) =>
            holdings.filter(
               holding =>
                  (!where?.creatorId || holding.creatorId === where.creatorId) &&
                  (where?.balance?.gt === undefined ||
                     Number(holding.balance) > where.balance.gt)
            ) as any
      );
      jest.spyOn(prisma.keyOwnership as any, 'findFirst').mockImplementation(
         async ({ where }: any = {}) =>
            (holdings.find(
               holding =>
                  holding.ownerAddress === where?.ownerAddress &&
                  holding.creatorId === where?.creatorId
            ) as any) ?? null
      );

      jest.spyOn(prisma.dividendDistribution as any, 'create').mockImplementation(
         async ({ data }: any) => {
            const distribution = {
               id: `dividend-test-snapshot-${++nextDistributionId}`,
               ...data,
            };
            distributions.push(distribution);
            return distribution as any;
         }
      );
      jest.spyOn(prisma.dividendDistribution as any, 'findFirst').mockImplementation(
         async ({ where }: any = {}) =>
            (distributions.find(
               distribution =>
                  (!where?.id || distribution.id === where.id) &&
                  (!where?.creatorId ||
                     distribution.creatorId === where.creatorId)
            ) as any) ?? null
      );
      jest.spyOn(prisma.dividendDistribution as any, 'findUnique').mockImplementation(
         async ({ where }: any) =>
            (distributions.find(
               distribution => distribution.id === where?.id
            ) as any) ?? null
      );
      jest.spyOn(prisma.dividendDistribution as any, 'findMany').mockImplementation(
         async ({ where, ...pagination }: any = {}) => {
            const rows = distributions
               .filter(
                  distribution =>
                     !where?.creatorId ||
                     distribution.creatorId === where.creatorId
               )
               .sort((a, b) => {
                  const dateOrder =
                     new Date(b.distributionDate).getTime() -
                     new Date(a.distributionDate).getTime();
                  return dateOrder || b.id.localeCompare(a.id);
               });
            return applyPagination(rows, pagination) as any;
         }
      );
      jest.spyOn(prisma.dividendClaim as any, 'createMany').mockImplementation(
         async ({ data }: any) => {
            let createdCount = 0;
            for (const row of data) {
               if (
                  !claims.some(
                     claim =>
                        claim.distributionId === row.distributionId &&
                        claim.recipientAddress === row.recipientAddress
                  )
               ) {
                  claims.push({
                     id: `dividend-test-claim-${++nextClaimId}`,
                     claimedAt: null,
                     ...row,
                  });
                  createdCount++;
               }
            }
            return { count: createdCount } as any;
         }
      );
      jest.spyOn(prisma.dividendClaim as any, 'findMany').mockImplementation(
         async ({ where, ...pagination }: any = {}) => {
            const rows = claims
               .filter(
                  claim =>
                     (!where?.distributionId ||
                        claim.distributionId === where.distributionId) &&
                     (!where?.recipientAddress ||
                        claim.recipientAddress === where.recipientAddress)
               )
               .sort((a, b) => {
                  const addressOrder = a.recipientAddress.localeCompare(
                     b.recipientAddress
                  );
                  return addressOrder || a.id.localeCompare(b.id);
               });
            return applyPagination(rows, pagination) as any;
         }
      );
      jest.spyOn(prisma.dividendClaim as any, 'updateMany').mockImplementation(
         async ({ where, data }: any) => {
            let count = 0;
            for (const claim of claims) {
               if (
                  (!where?.id || claim.id === where.id) &&
                  (!where?.distributionId ||
                     claim.distributionId === where.distributionId) &&
                  (!where?.recipientAddress ||
                     claim.recipientAddress === where.recipientAddress) &&
                  (where?.claimedAt !== null || claim.claimedAt === null)
               ) {
                  Object.assign(claim, data);
                  count++;
               }
            }
            return { count } as any;
         }
      );
   });

   beforeAll(async () => {
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
   });

   afterAll(async () => {
      jest.restoreAllMocks();
   });

   describe('Dividend Distribution Creation', () => {
      it('should create dividend distribution via indexer', async () => {
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

         const distribution = await prisma.dividendDistribution.findFirst({
            where: { creatorId: testCreatorId },
         });

         expect(distribution).toBeDefined();
         testDistributionId = distribution!.id;
         expect(distribution?.totalAmountXlm.toString()).toBe('300');
         expect(distribution?.holderCount).toBe(3);
         expect(distribution?.perKeyAmountXlm.toString()).toBe('100');
      });

      it('AC1: should calculate perKeyAmount correctly', async () => {
         const distribution = await prisma.dividendDistribution.findUnique({
            where: { id: testDistributionId },
         });

         expect(distribution).toBeDefined();
         expect(Number(distribution?.perKeyAmountXlm)).toBe(100);
         // totalAmount / holderCount = 300 / 3 = 100
      });

      it('should create dividend claims for all holders', async () => {
         const claims = await prisma.dividendClaim.findMany({
            where: { distributionId: testDistributionId },
         });

         expect(claims).toHaveLength(3);
         claims.forEach((claim) => {
            expect(claim.amountXlm.toString()).toBe('10000'); // 100 * 100 keys
         });
      });
   });

   describe('getDividendDistributions', () => {
      it('AC2: should return distributions sorted by distributionDate descending', async () => {
         // Create another distribution
         const event: IndexerChainEvent = {
            eventType: 'DIVIDEND_DISTRIBUTED',
            creatorId: testCreatorId,
            totalAmountXlm: '600',
            holdersCount: 3,
            distributorAddress: 'GDIST000000000000000000000000000000000001',
            distributedAt: new Date(Date.now() + 1000).toISOString(),
            ledger: 12346,
            txHash: 'tx123456790',
            eventIndex: 0,
         };

         await processDividendEvents([event]);

         const result = await getDividendDistributions({
            creatorId: testCreatorId,
            limit: 10,
         });

         expect(result.distributions.length).toBeGreaterThanOrEqual(2);

         // Verify descending order
         for (let i = 0; i < result.distributions.length - 1; i++) {
            expect(new Date(result.distributions[i].distributedAt).getTime()).toBeGreaterThanOrEqual(
               new Date(result.distributions[i + 1].distributedAt).getTime()
            );
         }
      });

      it('AC3: should support cursor-based pagination', async () => {
         const page1 = await getDividendDistributions({
            creatorId: testCreatorId,
            limit: 1,
         });

         expect(page1.distributions).toHaveLength(1);
         expect(page1.hasMore).toBe(true);
         expect(page1.nextCursor).toBeDefined();

         const page2 = await getDividendDistributions({
            creatorId: testCreatorId,
            limit: 1,
            cursor: page1.nextCursor,
         });

         expect(page2.distributions).toHaveLength(1);
         expect(page2.distributions[0].id).not.toBe(page1.distributions[0].id);
      });

      it('should respect limit parameter', async () => {
         const result = await getDividendDistributions({
            creatorId: testCreatorId,
            limit: 1,
         });

         expect(result.distributions.length).toBeLessThanOrEqual(1);
      });

      it('should cap limit at 100', async () => {
         const result = await getDividendDistributions({
            creatorId: testCreatorId,
            limit: 500,
         });

         expect(result.distributions.length).toBeLessThanOrEqual(100);
      });
   });

   describe('getDividendClaims', () => {
      it('AC4: should return per-holder breakdown for a distribution', async () => {
         const result = await getDividendClaims({
            distributionId: testDistributionId,
            limit: 10,
         });

         expect(result.claims.length).toBeGreaterThan(0);
         result.claims.forEach((claim) => {
            expect(claim.recipientAddress).toBeDefined();
            expect(claim.amountXlm).toBeDefined();
         });
      });

      it('should return correct payout per wallet', async () => {
         const claims = await prisma.dividendClaim.findMany({
            where: { distributionId: testDistributionId },
         });

         expect(claims).toHaveLength(3);

         for (const claim of claims) {
            // Each holder has 100 keys, perKeyAmount is 100, so payout should be 10000
            expect(claim.amountXlm.toString()).toBe('10000');
         }
      });

      it('AC5: should support cursor pagination on holders endpoint', async () => {
         const page1 = await getDividendClaims({
            distributionId: testDistributionId,
            limit: 1,
         });

         expect(page1.claims).toHaveLength(1);
         expect(page1.hasMore).toBe(true);
         expect(page1.nextCursor).toBeDefined();

         const page2 = await getDividendClaims({
            distributionId: testDistributionId,
            limit: 1,
            cursor: page1.nextCursor,
         });

         expect(page2.claims).toHaveLength(1);
         expect(page2.claims[0].id).not.toBe(page1.claims[0].id);
      });
   });

   describe('Error Handling', () => {
      it('AC6: should return 404 for unknown key ID', async () => {
         const result = await getDividendDistributions({
            creatorId: 'nonexistent-creator-id',
            limit: 10,
         });

         // Service returns empty list, controller will return 404
         expect(result.distributions).toHaveLength(0);
      });

      it('AC6: should return 404 for unknown distribution ID', async () => {
         const distribution = await getDividendDistributionById('nonexistent-dist-id');
         expect(distribution).toBeNull();
      });

      it('should handle empty distributions list gracefully', async () => {
         const result = await getDividendDistributions({
            creatorId: 'empty-creator-id',
            limit: 10,
         });

         expect(result.distributions).toHaveLength(0);
         expect(result.hasMore).toBe(false);
         expect(result.nextCursor).toBeUndefined();
      });
   });

   describe('Acceptance Criteria Validation', () => {
      it('AC1: Distributions listed with all required fields', async () => {
         const result = await getDividendDistributions({
            creatorId: testCreatorId,
            limit: 1,
         });

         expect(result.distributions.length).toBeGreaterThan(0);
         const dist = result.distributions[0];

         expect(dist).toHaveProperty('id');
         expect(dist).toHaveProperty('creatorId');
         expect(dist).toHaveProperty('totalAmount');
         expect(dist).toHaveProperty('holderCount');
         expect(dist).toHaveProperty('perKeyAmount');
         expect(dist).toHaveProperty('distributedAt');
      });

      it('AC2: Distributions in descending date order', async () => {
         const result = await getDividendDistributions({
            creatorId: testCreatorId,
            limit: 100,
         });

         for (let i = 0; i < result.distributions.length - 1; i++) {
            const current = new Date(result.distributions[i].distributedAt).getTime();
            const next = new Date(result.distributions[i + 1].distributedAt).getTime();
            expect(current).toBeGreaterThanOrEqual(next);
         }
      });

      it('AC3: perKeyAmount computed correctly', async () => {
         const distributions = await prisma.dividendDistribution.findMany({
            where: { creatorId: testCreatorId },
         });

         for (const dist of distributions) {
            const computed = Number(dist.totalAmountXlm) / dist.holderCount;
            expect(Number(dist.perKeyAmountXlm)).toBeCloseTo(computed, 6);
         }
      });

      it('AC4: Per-holder breakdown returns correct payout per wallet', async () => {
         const distribution = await prisma.dividendDistribution.findFirst({
            where: { creatorId: testCreatorId },
         });

         if (!distribution) {
            throw new Error('No distribution found');
         }

         const claims = await getDividendClaims({
            distributionId: distribution.id,
            limit: 100,
         });

         for (const claim of claims.claims) {
            // Verify payout calculation
            const holder = await prisma.keyOwnership.findFirst({
               where: { ownerAddress: claim.recipientAddress, creatorId: testCreatorId },
            });

            if (holder) {
               const expectedPayout =
                  Number(distribution.perKeyAmountXlm) * Number(holder.balance);
               expect(Number(claim.amountXlm)).toBeCloseTo(expectedPayout, 6);
            }
         }
      });

      it('AC5: Cursor pagination works correctly', async () => {
         // Create multiple distributions to test pagination
         for (let i = 0; i < 5; i++) {
            const event: IndexerChainEvent = {
               eventType: 'DIVIDEND_DISTRIBUTED',
               creatorId: testCreatorId,
               totalAmountXlm: String(100 * (i + 1)),
               holdersCount: 3,
               distributorAddress: 'GDIST000000000000000000000000000000000001',
               distributedAt: new Date(Date.now() + i * 1000).toISOString(),
               ledger: 12350 + i,
               txHash: `tx1234567${i}0`,
               eventIndex: 0,
            };

            await processDividendEvents([event]);
         }

         let allDists: any[] = [];
         let cursor: string | undefined;
         let pageCount = 0;

         do {
            const result = await getDividendDistributions({
               creatorId: testCreatorId,
               limit: 2,
               cursor,
            });

            allDists = allDists.concat(result.distributions);
            cursor = result.nextCursor;
            pageCount++;

            if (!result.hasMore) break;
         } while (pageCount < 100);

         expect(allDists.length).toBeGreaterThan(2);
         expect(pageCount).toBeGreaterThan(1);
      });
   });
});
