// src/jobs/twap-computation.job.test.ts
jest.mock('../config', () => ({
   envConfig: {
      TWAP_COMPUTATION_ENABLED: true,
      TWAP_COMPUTATION_INTERVAL_MINUTES: 5,
   },
}));

jest.mock('../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findMany: jest.fn() },
   },
}));

jest.mock('../utils/logger.utils', () => ({
   logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../modules/keys/key-twap.service', () => ({
   computeAndCacheTwap: jest.fn(),
   KeyNotFoundError: class KeyNotFoundError extends Error {},
}));

jest.mock('../modules/keys/key-registration.service', () => ({
   keyEventEmitter: { on: jest.fn(), removeListener: jest.fn() },
}));

import { prisma } from '../utils/prisma.utils';
import { computeAndCacheTwap } from '../modules/keys/key-twap.service';
import {
   backfillTwapForKey,
   computeTwapForAllKeys,
} from './twap-computation.job';

const mockPrisma = prisma as unknown as {
   creatorProfile: { findMany: jest.Mock };
};
const mockCompute = computeAndCacheTwap as jest.Mock;

describe('twap-computation job', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockCompute.mockResolvedValue({});
   });

   it('computes all three windows per active key', async () => {
      mockPrisma.creatorProfile.findMany.mockResolvedValue([
         { id: 'key-1' },
         { id: 'key-2' },
      ]);

      const result = await computeTwapForAllKeys();

      expect(mockPrisma.creatorProfile.findMany).toHaveBeenCalledWith({
         where: { deprecatedAt: null },
         select: { id: true },
      });
      expect(result.scannedKeys).toBe(2);
      // 2 keys x 3 windows
      expect(mockCompute).toHaveBeenCalledTimes(6);
      expect(result.computedWrites).toBe(6);
      expect(result.failedWrites).toBe(0);
   });

   it('counts per-key failures without aborting the run', async () => {
      mockPrisma.creatorProfile.findMany.mockResolvedValue([{ id: 'key-1' }]);
      mockCompute
         .mockResolvedValueOnce({})
         .mockRejectedValueOnce(new Error('boom'))
         .mockResolvedValueOnce({});

      const result = await computeTwapForAllKeys();

      expect(result.computedWrites).toBe(2);
      expect(result.failedWrites).toBe(1);
   });

   it('backfills all windows for a single new key', async () => {
      await backfillTwapForKey('new-key');

      expect(mockCompute).toHaveBeenCalledTimes(3);
      expect(mockCompute).toHaveBeenCalledWith(
         'new-key',
         '1h',
         expect.any(Date)
      );
      expect(mockCompute).toHaveBeenCalledWith(
         'new-key',
         '4h',
         expect.any(Date)
      );
      expect(mockCompute).toHaveBeenCalledWith(
         'new-key',
         '24h',
         expect.any(Date)
      );
   });
});
