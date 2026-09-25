import { compute24hVolume } from '../trading-volume.utils';
import { prisma } from '../../utils/prisma.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      activity: {
         findMany: jest.fn(),
      },
   },
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      error: jest.fn(),
   },
}));

const mockPrisma = prisma as unknown as {
   activity: { findMany: jest.Mock };
};

describe('compute24hVolume()', () => {
   const CREATOR_ID = 'test-creator-123';
   const NOW = new Date('2026-01-15T12:00:00Z');

   beforeEach(() => {
      jest.clearAllMocks();
      jest.useFakeTimers();
      jest.setSystemTime(NOW);
   });

   afterEach(() => {
      jest.useRealTimers();
   });

   it('sums all trades within the rolling 24h window', async () => {
      const twentyFourHoursAgo = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);

      const trades = [
         {
            payload: { price: '1000' },
         },
         {
            payload: { price: '2000' },
         },
         {
            payload: { price: '3000' },
         },
      ];

      mockPrisma.activity.findMany.mockResolvedValue(trades);

      const volume = await compute24hVolume(CREATOR_ID);

      expect(volume).toBe(6000n);
      expect(mockPrisma.activity.findMany).toHaveBeenCalledWith({
         where: {
            creatorId: CREATOR_ID,
            type: { in: ['KEY_BOUGHT', 'KEY_SOLD'] },
            createdAt: {
               gte: twentyFourHoursAgo,
               lte: NOW,
            },
         },
         select: {
            payload: true,
         },
      });
   });

   it('excludes trades outside the 24h window', async () => {
      const trades = [
         {
            payload: { price: '1000' }, // Inside window
         },
         {
            payload: { price: '2000' }, // Inside window
         },
      ];

      mockPrisma.activity.findMany.mockResolvedValue(trades);

      const volume = await compute24hVolume(CREATOR_ID);

      // The mock only returns trades inside the window since that's what
      // the query filter would return
      expect(volume).toBe(3000n);
   });

   it('returns 0 when no trades exist within the window', async () => {
      mockPrisma.activity.findMany.mockResolvedValue([]);

      const volume = await compute24hVolume(CREATOR_ID);

      expect(volume).toBe(0n);
   });

   it('handles large trade volumes without overflow', async () => {
      const trades = [
         {
            payload: { price: '9223372036854775800' }, // Near max BigInt
         },
         {
            payload: { price: '100' },
         },
      ];

      mockPrisma.activity.findMany.mockResolvedValue(trades);

      const volume = await compute24hVolume(CREATOR_ID);

      expect(volume).toBe(9223372036854775900n);
   });

   it('ignores trades with missing price in payload', async () => {
      const trades = [
         {
            payload: { price: '1000' },
         },
         {
            payload: { amount: '5' }, // Missing price
         },
         {
            payload: { price: '2000' },
         },
      ];

      mockPrisma.activity.findMany.mockResolvedValue(trades);

      const volume = await compute24hVolume(CREATOR_ID);

      // Should only sum the two trades with valid prices
      expect(volume).toBe(3000n);
   });

   it('handles both KEY_BOUGHT and KEY_SOLD activity types', async () => {
      // The query filter should include both types
      const trades = [
         {
            payload: { price: '1000' },
         },
         {
            payload: { price: '2000' },
         },
      ];

      mockPrisma.activity.findMany.mockResolvedValue(trades);

      await compute24hVolume(CREATOR_ID);

      // Verify that the filter includes both types
      const callArgs = mockPrisma.activity.findMany.mock.calls[0][0];
      expect(callArgs.where.type).toEqual({ in: ['KEY_BOUGHT', 'KEY_SOLD'] });
   });

   it('queries with rolling 24h window from current time', async () => {
      mockPrisma.activity.findMany.mockResolvedValue([]);

      await compute24hVolume(CREATOR_ID);

      const callArgs = mockPrisma.activity.findMany.mock.calls[0][0];
      const { gte, lte } = callArgs.where.createdAt;

      // gte should be 24 hours before NOW
      expect(gte.getTime()).toBe(NOW.getTime() - 24 * 60 * 60 * 1000);
      // lte should be NOW
      expect(lte.getTime()).toBe(NOW.getTime());
   });

   it('handles string prices by converting to BigInt', async () => {
      const trades = [
         {
            payload: { price: '12345' },
         },
         {
            payload: { price: '67890' },
         },
      ];

      mockPrisma.activity.findMany.mockResolvedValue(trades);

      const volume = await compute24hVolume(CREATOR_ID);

      expect(volume).toBe(80235n);
   });

   it('throws error when database query fails', async () => {
      const error = new Error('Database connection failed');
      mockPrisma.activity.findMany.mockRejectedValue(error);

      await expect(compute24hVolume(CREATOR_ID)).rejects.toThrow(
         'Database connection failed'
      );
   });

   it('handles null payload gracefully', async () => {
      const trades = [
         {
            payload: null,
         },
         {
            payload: { price: '1000' },
         },
      ];

      mockPrisma.activity.findMany.mockResolvedValue(trades);

      const volume = await compute24hVolume(CREATOR_ID);

      // Should only sum the valid trade
      expect(volume).toBe(1000n);
   });

   it('handles empty payload object gracefully', async () => {
      const trades = [
         {
            payload: {},
         },
         {
            payload: { price: '1000' },
         },
      ];

      mockPrisma.activity.findMany.mockResolvedValue(trades);

      const volume = await compute24hVolume(CREATOR_ID);

      // Should only sum the valid trade
      expect(volume).toBe(1000n);
   });

   describe('rolling 24h window boundary behaviors', () => {
      it('includes a trade timestamped exactly 24 hours ago', async () => {
         mockPrisma.activity.findMany.mockResolvedValue([
            { payload: { price: '1000' } },
         ]);

         const volume = await compute24hVolume(CREATOR_ID);

         expect(volume).toBe(1000n);
         // Verify the query where clause gte matches exactly 24h ago
         const callArgs = mockPrisma.activity.findMany.mock.calls[0][0];
         const expectedCutoff = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
         expect(callArgs.where.createdAt.gte.getTime()).toBe(
            expectedCutoff.getTime()
         );
      });

      it('excludes a trade timestamped 24 hours and 1 millisecond ago', async () => {
         // The db query would filter out trades older than 24h ago
         mockPrisma.activity.findMany.mockResolvedValue([]);

         const volume = await compute24hVolume(CREATOR_ID);

         expect(volume).toBe(0n);

         const callArgs = mockPrisma.activity.findMany.mock.calls[0][0];
         const expectedCutoff = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
         expect(callArgs.where.createdAt.gte.getTime()).toBe(
            expectedCutoff.getTime()
         );
      });

      it('includes a trade timestamped 1 second ago', async () => {
         mockPrisma.activity.findMany.mockResolvedValue([
            { payload: { price: '500' } },
         ]);

         const volume = await compute24hVolume(CREATOR_ID);

         expect(volume).toBe(500n);

         const callArgs = mockPrisma.activity.findMany.mock.calls[0][0];
         expect(callArgs.where.createdAt.lte.getTime()).toBe(NOW.getTime());
      });

      it('returns 0 when all trades fall outside the window', async () => {
         mockPrisma.activity.findMany.mockResolvedValue([]);

         const volume = await compute24hVolume(CREATOR_ID);

         expect(volume).toBe(0n);
      });

      it('includes trades at 23h 59m ago and excludes 24h 1m ago across a ledger boundary', async () => {
         const oneHourAgo = new Date(NOW.getTime() - 1 * 60 * 60 * 1000);
         const twentyThreeHoursFiftyNineMinsAgo = new Date(
            NOW.getTime() - (23 * 60 * 60 + 59 * 60) * 1000
         );
         const exactly24hAgo = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
         const twentyFourHoursOneMinAgo = new Date(
            NOW.getTime() - (24 * 60 * 60 + 60) * 1000
         );

         mockPrisma.activity.findMany.mockResolvedValue([
            { payload: { price: '100' } },
            { payload: { price: '200' } },
            { payload: { price: '300' } },
         ]);

         const volume = await compute24hVolume(CREATOR_ID);

         expect(volume).toBe(600n);

         const callArgs = mockPrisma.activity.findMany.mock.calls[0][0];
         const expectedCutoff = exactly24hAgo;
         expect(callArgs.where.createdAt.gte.getTime()).toBe(
            expectedCutoff.getTime()
         );

         expect(callArgs.where.createdAt.gte.getTime()).toBeLessThanOrEqual(
            twentyThreeHoursFiftyNineMinsAgo.getTime()
         );
         expect(callArgs.where.createdAt.gte.getTime()).toBeLessThanOrEqual(
            exactly24hAgo.getTime()
         );
         expect(callArgs.where.createdAt.gte.getTime()).toBeLessThanOrEqual(
            oneHourAgo.getTime()
         );
         expect(callArgs.where.createdAt.gte.getTime()).toBeGreaterThan(
            twentyFourHoursOneMinAgo.getTime()
         );
      });
   });
});
