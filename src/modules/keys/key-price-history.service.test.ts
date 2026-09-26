jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorPriceHistory: {
         findMany: jest.fn(),
      },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import { getKeyPriceSnapshots } from './key-price-history.service';

describe('#893 getKeyPriceSnapshots — raw range query for TWAP/analytics', () => {
   const mockPrisma = prisma as unknown as {
      creatorPriceHistory: { findMany: jest.Mock };
   };

   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('queries by creatorId and an inclusive recordedAt range, ordered oldest first', async () => {
      mockPrisma.creatorPriceHistory.findMany.mockResolvedValue([]);

      const from = new Date('2026-01-01T00:00:00.000Z');
      const to = new Date('2026-01-31T00:00:00.000Z');

      await getKeyPriceSnapshots('creator-1', from, to);

      expect(mockPrisma.creatorPriceHistory.findMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { creatorId: 'creator-1', recordedAt: { gte: from, lte: to } },
            orderBy: { recordedAt: 'asc' },
         })
      );
   });

   it('returns price, supply, direction and timestamp for each snapshot in range', async () => {
      const recordedAt = new Date('2026-01-15T12:00:00.000Z');
      mockPrisma.creatorPriceHistory.findMany.mockResolvedValue([
         { recordedAt, price: 2_000_000n, supply: 150n, direction: 'BUY' },
      ]);

      const result = await getKeyPriceSnapshots(
         'creator-1',
         new Date('2026-01-01T00:00:00.000Z'),
         new Date('2026-01-31T00:00:00.000Z')
      );

      expect(result).toEqual([
         { timestamp: recordedAt, price: 2_000_000n, supply: 150n, direction: 'BUY' },
      ]);
   });

   it('caps the number of rows returned to protect range-query performance', async () => {
      mockPrisma.creatorPriceHistory.findMany.mockResolvedValue([]);

      await getKeyPriceSnapshots(
         'creator-1',
         new Date('2026-01-01T00:00:00.000Z'),
         new Date('2026-01-31T00:00:00.000Z')
      );

      const call = mockPrisma.creatorPriceHistory.findMany.mock.calls[0][0];
      expect(call.take).toBeGreaterThan(0);
   });
});
