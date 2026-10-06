jest.mock('../config', () => ({
   envConfig: {
      PRICE_HISTORY_RETENTION_DAYS: 30,
      PRICE_HISTORY_CLEANUP_ENABLED: true,
      PRICE_HISTORY_CLEANUP_INTERVAL_MINUTES: 60,
   },
}));

jest.mock('../utils/prisma.utils', () => ({
   prisma: {
      creatorPriceHistory: {
         findMany: jest.fn(),
         deleteMany: jest.fn(),
      },
   },
}));

jest.mock('../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
   },
}));

import { envConfig } from '../config';
import { prisma } from '../utils/prisma.utils';
import { cleanupExpiredPriceHistory } from './price-history-cleanup.job';

describe('price-history-cleanup.job', () => {
   const mockPrisma = prisma as unknown as {
      creatorPriceHistory: { findMany: jest.Mock; deleteMany: jest.Mock };
   };

   beforeEach(() => {
      jest.clearAllMocks();
      mockPrisma.creatorPriceHistory.findMany.mockReset();
      mockPrisma.creatorPriceHistory.deleteMany.mockReset();
      envConfig.PRICE_HISTORY_RETENTION_DAYS = 30;
   });

   it('deletes rows older than the retention cutoff (30 days by default)', async () => {
      const now = new Date('2026-02-01T00:00:00.000Z');
      mockPrisma.creatorPriceHistory.findMany.mockResolvedValueOnce([
         { id: 'a' },
         { id: 'b' },
      ]);
      mockPrisma.creatorPriceHistory.deleteMany.mockResolvedValueOnce({
         count: 2,
      });

      const result = await cleanupExpiredPriceHistory({ now: () => now });

      const expectedCutoff = new Date('2026-01-02T00:00:00.000Z');
      expect(result).toMatchObject({
         deletedCount: 2,
         retentionDays: 30,
      });
      expect(result.cutoffTimestamp.toISOString()).toBe(
         expectedCutoff.toISOString()
      );

      expect(mockPrisma.creatorPriceHistory.findMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { recordedAt: { lt: expectedCutoff } },
         })
      );
      expect(mockPrisma.creatorPriceHistory.deleteMany).toHaveBeenCalledWith({
         where: { id: { in: ['a', 'b'] } },
      });
   });

   it('respects a configured retention window other than 30 days', async () => {
      envConfig.PRICE_HISTORY_RETENTION_DAYS = 7;
      const now = new Date('2026-02-01T00:00:00.000Z');
      mockPrisma.creatorPriceHistory.findMany.mockResolvedValueOnce([]);

      const result = await cleanupExpiredPriceHistory({ now: () => now });

      expect(result.retentionDays).toBe(7);
      expect(result.cutoffTimestamp.toISOString()).toBe(
         new Date('2026-01-25T00:00:00.000Z').toISOString()
      );
      expect(mockPrisma.creatorPriceHistory.deleteMany).not.toHaveBeenCalled();
   });

   it('batches deletes across multiple pages when the backlog is large', async () => {
      const now = new Date('2026-02-01T00:00:00.000Z');
      const firstBatch = Array.from({ length: 2 }, (_, i) => ({ id: `p1-${i}` }));
      const secondBatch = Array.from({ length: 1 }, (_, i) => ({ id: `p2-${i}` }));
      mockPrisma.creatorPriceHistory.findMany
         .mockResolvedValueOnce(firstBatch)
         .mockResolvedValueOnce(secondBatch);
      mockPrisma.creatorPriceHistory.deleteMany
         .mockResolvedValueOnce({ count: firstBatch.length })
         .mockResolvedValueOnce({ count: secondBatch.length });

      // Force pagination with a tiny batch size so the second (smaller)
      // page still triggers a loop continuation to confirm the batching
      // logic itself, independent of the production BATCH_SIZE constant.
      const result = await cleanupExpiredPriceHistory({
         now: () => now,
         batchSize: 2,
      });

      expect(result.deletedCount).toBe(3);
      expect(mockPrisma.creatorPriceHistory.deleteMany).toHaveBeenCalledTimes(2);
   });

   it('leaves rows within the retention window untouched', async () => {
      const now = new Date('2026-02-01T00:00:00.000Z');
      mockPrisma.creatorPriceHistory.findMany.mockResolvedValueOnce([]);

      const result = await cleanupExpiredPriceHistory({ now: () => now });

      expect(result.deletedCount).toBe(0);
      expect(mockPrisma.creatorPriceHistory.deleteMany).not.toHaveBeenCalled();
   });
});
