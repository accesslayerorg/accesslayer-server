// src/modules/campaigns/campaign-activity.utils.test.ts

import { fetchCandidateWalletsBatch } from './campaign-activity.utils';

describe('campaign-activity.utils', () => {
   const now = new Date('2026-10-20T12:00:00.000Z');

   const mockPrisma = {
      trade: {
         findMany: jest.fn(),
      },
      activity: {
         findMany: jest.fn(),
         groupBy: jest.fn(),
      },
   };

   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('aggregates trade volume and filters by threshold', async () => {
      const campaign = {
         id: 'camp-vol',
         name: 'Trade Volume Campaign',
         status: 'ACTIVE',
         criteriaType: 'TRADE_VOLUME',
         threshold: 100,
         startDate: new Date('2026-10-01T00:00:00.000Z'),
         endDate: new Date('2026-10-31T00:00:00.000Z'),
         criteria: null,
         contractAddress: null,
         lastCheckedAt: null,
         createdAt: new Date(),
         updatedAt: new Date(),
         description: null,
      } as any;

      // 1. distinct buyers
      mockPrisma.trade.findMany
         .mockResolvedValueOnce([
            { buyer: 'WALLET_A' },
            { buyer: 'WALLET_B' },
         ])
         // 2. trades for those buyers
         .mockResolvedValueOnce([
            { buyer: 'WALLET_A', price: '10', quantity: '15' }, // 150 -> meets >= 100
            { buyer: 'WALLET_B', price: '10', quantity: '5' },  // 50 -> below 100
         ]);

      const result = await fetchCandidateWalletsBatch({
         campaign,
         offset: 0,
         batchSize: 2,
         now,
         prisma: mockPrisma as any,
      });

      expect(result.candidates).toEqual([
         { wallet: 'WALLET_A', metricValue: 150 },
      ]);
      expect(result.hasMore).toBe(true);
      expect(result.totalProcessedInBatch).toBe(2);
   });

   it('counts trades for TRADE_COUNT criteria', async () => {
      const campaign = {
         id: 'camp-count',
         name: 'Trade Count Campaign',
         status: 'ACTIVE',
         criteriaType: 'TRADE_COUNT',
         threshold: 2,
         startDate: new Date('2026-10-01T00:00:00.000Z'),
         endDate: new Date('2026-10-31T00:00:00.000Z'),
         criteria: null,
         contractAddress: null,
         lastCheckedAt: null,
         createdAt: new Date(),
         updatedAt: new Date(),
         description: null,
      } as any;

      mockPrisma.trade.findMany
         .mockResolvedValueOnce([
            { buyer: 'WALLET_A' },
            { buyer: 'WALLET_B' },
         ])
         .mockResolvedValueOnce([
            { buyer: 'WALLET_A', price: '1', quantity: '1' },
            { buyer: 'WALLET_A', price: '1', quantity: '1' }, // 2 trades -> meets >= 2
            { buyer: 'WALLET_B', price: '1', quantity: '1' }, // 1 trade -> below 2
         ]);

      const result = await fetchCandidateWalletsBatch({
         campaign,
         offset: 0,
         batchSize: 10,
         now,
         prisma: mockPrisma as any,
      });

      expect(result.candidates).toEqual([
         { wallet: 'WALLET_A', metricValue: 2 },
      ]);
      expect(result.hasMore).toBe(false);
      expect(result.totalProcessedInBatch).toBe(2);
   });

   it('evaluates activity count for ACTIVITY_COUNT criteria', async () => {
      const campaign = {
         id: 'camp-act',
         name: 'Activity Campaign',
         status: 'ACTIVE',
         criteriaType: 'ACTIVITY_COUNT',
         threshold: 3,
         startDate: new Date('2026-10-01T00:00:00.000Z'),
         endDate: new Date('2026-10-31T00:00:00.000Z'),
         criteria: null,
         contractAddress: null,
         lastCheckedAt: null,
         createdAt: new Date(),
         updatedAt: new Date(),
         description: null,
      } as any;

      mockPrisma.activity.findMany.mockResolvedValueOnce([
         { actor: 'ACTOR_A' },
      ]);
      mockPrisma.activity.groupBy.mockResolvedValueOnce([
         { actor: 'ACTOR_A', _count: { _all: 5 } },
      ]);

      const result = await fetchCandidateWalletsBatch({
         campaign,
         offset: 0,
         batchSize: 5,
         now,
         prisma: mockPrisma as any,
      });

      expect(result.candidates).toEqual([
         { wallet: 'ACTOR_A', metricValue: 5 },
      ]);
   });
});
