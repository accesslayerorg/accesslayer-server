// src/modules/indexer/price-snapshot-writer.unit.test.ts
// Unit tests for #763: the price snapshot writer skips the write when the
// new price equals the most recent stored snapshot for that creator.
//
// Uses jest mocks; no database required.

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorPriceHistory: {
         findFirst: jest.fn(),
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

import { prisma } from '../../utils/prisma.utils';
import { writePriceSnapshot } from './price-snapshot-writer';

const mockPrisma = prisma as unknown as {
   creatorPriceHistory: {
      findFirst: jest.Mock;
      create: jest.Mock;
   };
};

const CREATOR_ID = 'creator-763';

describe('#763 price snapshot writer', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockPrisma.creatorPriceHistory.findFirst.mockReset();
      mockPrisma.creatorPriceHistory.create.mockReset();
      mockPrisma.creatorPriceHistory.create.mockResolvedValue({ id: 'row' });
   });

   it('reads the most recent snapshot for the creator', async () => {
      mockPrisma.creatorPriceHistory.findFirst.mockResolvedValue(null);

      await writePriceSnapshot(CREATOR_ID, BigInt(1_000_000));

      expect(mockPrisma.creatorPriceHistory.findFirst).toHaveBeenCalledWith({
         where: { creatorId: CREATOR_ID },
         orderBy: { recordedAt: 'desc' },
         select: { price: true },
      });
   });

   it('skips the database write when the price is unchanged', async () => {
      mockPrisma.creatorPriceHistory.findFirst.mockResolvedValue({
         price: BigInt(1_000_000),
      });

      const result = await writePriceSnapshot(CREATOR_ID, BigInt(1_000_000));

      expect(mockPrisma.creatorPriceHistory.create).not.toHaveBeenCalled();
      expect(result).toEqual({ written: false, reason: 'unchanged' });
   });

   it('writes when the price differs from the previous snapshot', async () => {
      mockPrisma.creatorPriceHistory.findFirst.mockResolvedValue({
         price: BigInt(1_000_000),
      });

      const result = await writePriceSnapshot(CREATOR_ID, BigInt(1_100_000));

      expect(mockPrisma.creatorPriceHistory.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.creatorPriceHistory.create).toHaveBeenCalledWith({
         data: { creatorId: CREATOR_ID, price: BigInt(1_100_000) },
      });
      expect(result).toEqual({ written: true, reason: 'changed' });
   });

   it('always writes the first snapshot for a creator', async () => {
      mockPrisma.creatorPriceHistory.findFirst.mockResolvedValue(null);

      const result = await writePriceSnapshot(CREATOR_ID, BigInt(1_000_000));

      expect(mockPrisma.creatorPriceHistory.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.creatorPriceHistory.create).toHaveBeenCalledWith({
         data: { creatorId: CREATOR_ID, price: BigInt(1_000_000) },
      });
      expect(result).toEqual({ written: true, reason: 'first' });
   });

   it('uses injected dependencies when provided', async () => {
      const findLatest = jest.fn().mockResolvedValue({ price: BigInt(5) });
      const create = jest.fn().mockResolvedValue(undefined);

      const unchanged = await writePriceSnapshot(CREATOR_ID, BigInt(5), {
         findLatest,
         create,
      });
      const changed = await writePriceSnapshot(CREATOR_ID, BigInt(6), {
         findLatest,
         create,
      });

      expect(findLatest).toHaveBeenCalledWith(CREATOR_ID);
      expect(create).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledWith(CREATOR_ID, BigInt(6));
      expect(unchanged).toEqual({ written: false, reason: 'unchanged' });
      expect(changed).toEqual({ written: true, reason: 'changed' });
      expect(mockPrisma.creatorPriceHistory.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.creatorPriceHistory.create).not.toHaveBeenCalled();
   });
});
