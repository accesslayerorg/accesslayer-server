// src/modules/indexer/price-snapshot-debug-log.unit.test.ts
// Unit tests for #636 — debug-level log emitted after each successful
// price snapshot write, with creator_id, new_price, previous_price,
// ledger and ingested_at fields.
//
// Uses jest mocks — no database required.

import { upsertPriceSnapshot } from './price-snapshot.service';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorPriceSnapshot: {
         findUnique: jest.fn(),
         create: jest.fn(),
         update: jest.fn(),
      },
      creatorPriceHistory: {
         create: jest.fn(),
      },
   },
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      debug: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
   },
}));

const mockPrisma = prisma as unknown as {
   creatorPriceSnapshot: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
   };
   creatorPriceHistory: {
      create: jest.Mock;
   };
};

const mockLogger = logger as unknown as {
   debug: jest.Mock;
   error: jest.Mock;
};

const CREATOR_ID = 'creator-debug-log-1';

describe('#636 price snapshot write debug log', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('emits a debug log with all five fields after the first (create) snapshot write', async () => {
      mockPrisma.creatorPriceSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.creatorPriceSnapshot.create.mockResolvedValue({});

      const tradeAt = new Date('2026-01-01T00:00:00Z');
      await upsertPriceSnapshot({
         creatorId: CREATOR_ID,
         price: BigInt(1_000_000),
         tradeAt,
         ledger: 5000,
      });

      expect(mockPrisma.creatorPriceSnapshot.create).toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledTimes(1);

      const [fields] = mockLogger.debug.mock.calls[0];
      expect(fields).toMatchObject({
         creator_id: CREATOR_ID,
         new_price: '1000000',
         previous_price: null,
         ledger: 5000,
      });
      expect(fields.ingested_at).toEqual(expect.any(String));
      expect(() => new Date(fields.ingested_at).toISOString()).not.toThrow();
   });

   it('sets previous_price to null on the first snapshot for a creator', async () => {
      mockPrisma.creatorPriceSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.creatorPriceSnapshot.create.mockResolvedValue({});

      await upsertPriceSnapshot({
         creatorId: CREATOR_ID,
         price: BigInt(2_000_000),
         tradeAt: new Date('2026-01-01T00:00:00Z'),
         ledger: 5001,
      });

      const [fields] = mockLogger.debug.mock.calls[0];
      expect(fields.previous_price).toBeNull();
   });

   it('skips snapshot and history writes when the price is unchanged', async () => {
      mockPrisma.creatorPriceSnapshot.findUnique.mockResolvedValue({
         creatorId: CREATOR_ID,
         currentPrice: BigInt(1_000_000),
         price24hAgo: BigInt(900_000),
         lastTradeAt: new Date('2026-01-01T00:00:00Z'),
      });

      await upsertPriceSnapshot({
         creatorId: CREATOR_ID,
         price: BigInt(1_000_000),
         tradeAt: new Date('2026-01-02T00:00:00Z'),
      });

      expect(mockPrisma.creatorPriceSnapshot.update).not.toHaveBeenCalled();
      expect(mockPrisma.creatorPriceHistory.create).not.toHaveBeenCalled();
   });

   it('writes a new snapshot and history record when the price changes', async () => {
      mockPrisma.creatorPriceSnapshot.findUnique.mockResolvedValue({
         creatorId: CREATOR_ID,
         currentPrice: BigInt(1_000_000),
         price24hAgo: BigInt(900_000),
         lastTradeAt: new Date('2026-01-01T00:00:00Z'),
      });
      mockPrisma.creatorPriceSnapshot.update.mockResolvedValue({});
      mockPrisma.creatorPriceHistory.create.mockResolvedValue({});

      const tradeAt = new Date('2026-01-02T00:00:00Z');
      await upsertPriceSnapshot({
         creatorId: CREATOR_ID,
         price: BigInt(1_100_000),
         tradeAt,
      });

      expect(mockPrisma.creatorPriceSnapshot.update).toHaveBeenCalledTimes(1);
      expect(mockPrisma.creatorPriceHistory.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.creatorPriceHistory.create).toHaveBeenCalledWith({
         data: {
            creatorId: CREATOR_ID,
            price: BigInt(1_100_000),
            recordedAt: tradeAt,
         },
      });
   });

   it('writes the first snapshot when no previous snapshot exists', async () => {
      mockPrisma.creatorPriceSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.creatorPriceSnapshot.create.mockResolvedValue({});
      mockPrisma.creatorPriceHistory.create.mockResolvedValue({});

      await upsertPriceSnapshot({
         creatorId: CREATOR_ID,
         price: BigInt(1_000_000),
         tradeAt: new Date('2026-01-01T00:00:00Z'),
      });

      expect(mockPrisma.creatorPriceSnapshot.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.creatorPriceHistory.create).toHaveBeenCalledTimes(1);
   });

   it('emits a debug log with the previous price on a subsequent (update) write', async () => {
      mockPrisma.creatorPriceSnapshot.findUnique.mockResolvedValue({
         creatorId: CREATOR_ID,
         currentPrice: BigInt(1_000_000),
         price24hAgo: BigInt(1_000_000),
         lastTradeAt: new Date('2025-12-01T00:00:00Z'),
      });
      mockPrisma.creatorPriceSnapshot.update.mockResolvedValue({});

      await upsertPriceSnapshot({
         creatorId: CREATOR_ID,
         price: BigInt(3_000_000),
         tradeAt: new Date('2026-01-02T00:00:00Z'),
         ledger: 5002,
      });

      expect(mockPrisma.creatorPriceSnapshot.update).toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledTimes(1);

      const [fields] = mockLogger.debug.mock.calls[0];
      expect(fields).toMatchObject({
         creator_id: CREATOR_ID,
         new_price: '3000000',
         previous_price: '1000000',
         ledger: 5002,
      });
      expect(fields.ingested_at).toEqual(expect.any(String));
   });

   it('does not emit the debug log when the write fails', async () => {
      mockPrisma.creatorPriceSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.creatorPriceSnapshot.create.mockRejectedValue(
         new Error('db write failed')
      );

      await expect(
         upsertPriceSnapshot({
            creatorId: CREATOR_ID,
            price: BigInt(1_000_000),
            tradeAt: new Date('2026-01-01T00:00:00Z'),
            ledger: 5003,
         })
      ).rejects.toThrow('db write failed');

      expect(mockLogger.debug).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalled();
   });
});
