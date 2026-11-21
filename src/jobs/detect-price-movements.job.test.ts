// src/jobs/detect-price-movements.job.test.ts
jest.mock('../config', () => ({
   envConfig: {
      DETECT_PRICE_MOVEMENTS_ENABLED: false,
      DETECT_PRICE_MOVEMENTS_INTERVAL_MINUTES: 5,
   },
}));

jest.mock('../utils/prisma.utils', () => ({
   prisma: {
      creatorPriceSnapshot: {
         findMany: jest.fn(),
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

jest.mock('../modules/keys/price-moved.redis', () => ({
   writePriceMovedKeys: jest.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../utils/prisma.utils';
import { writePriceMovedKeys } from '../modules/keys/price-moved.redis';
import { detectPriceMovements } from './detect-price-movements.job';

describe('detectPriceMovements', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('flags keys that moved more than 10% and skips those within 10%', async () => {
      (prisma.creatorPriceSnapshot.findMany as jest.Mock).mockResolvedValue([
         {
            creatorId: 'moved-up',
            currentPrice: 1200n,
            price24hAgo: 1000n, // +20%
         },
         {
            creatorId: 'moved-down',
            currentPrice: 800n,
            price24hAgo: 1000n, // -20%
         },
         {
            creatorId: 'stable',
            currentPrice: 1050n,
            price24hAgo: 1000n, // +5%
         },
         {
            creatorId: 'exact-10',
            currentPrice: 1100n,
            price24hAgo: 1000n, // exactly 10% — not greater than
         },
      ]);

      const result = await detectPriceMovements();

      expect(result.scanned).toBe(4);
      expect(result.flagged).toBe(2);
      expect(result.keyIds).toEqual(['moved-up', 'moved-down']);
      expect(writePriceMovedKeys).toHaveBeenCalledWith([
         'moved-up',
         'moved-down',
      ]);
   });

   it('writes an empty set when no keys exceed the threshold', async () => {
      (prisma.creatorPriceSnapshot.findMany as jest.Mock).mockResolvedValue([
         {
            creatorId: 'stable',
            currentPrice: 1010n,
            price24hAgo: 1000n,
         },
      ]);

      const result = await detectPriceMovements();

      expect(result.keyIds).toEqual([]);
      expect(writePriceMovedKeys).toHaveBeenCalledWith([]);
   });
});
