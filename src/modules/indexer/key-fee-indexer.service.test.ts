// src/modules/indexer/key-fee-indexer.service.test.ts

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findFirst: jest.fn(),
      },
      keyFeeHistory: {
         upsert: jest.fn(),
      },
   },
}));

jest.mock('../keys/key-swap-fee.service', () => ({
   invalidateKeyFeeCache: jest.fn(),
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

import { prisma } from '../../utils/prisma.utils';
import { invalidateKeyFeeCache } from '../keys/key-swap-fee.service';
import {
   processFeeAdjustedEvents,
   FeeAdjustedChainEvent,
} from './key-fee-indexer.service';

const mockPrisma = prisma as unknown as {
   creatorProfile: { findFirst: jest.Mock };
   keyFeeHistory: { upsert: jest.Mock };
};
const mockInvalidateCache = invalidateKeyFeeCache as jest.Mock;

describe('key-fee-indexer.service', () => {
   const KEY_ID = 'key-uuid-1';

   beforeEach(() => {
      jest.clearAllMocks();
      mockPrisma.creatorProfile.findFirst.mockResolvedValue({
         id: KEY_ID,
      });
      mockPrisma.keyFeeHistory.upsert.mockResolvedValue({
         id: 'fee-hist-1',
      });
   });

   it('indexes FeeAdjusted event and invalidates cache for affected key', async () => {
      const event: FeeAdjustedChainEvent = {
         eventType: 'FeeAdjusted',
         keyId: KEY_ID,
         feeBps: 300,
         previousFeeBps: 400,
         volumeBracket: 'TIER_3',
         rolling24hVolume: '5500000000',
         ledger: 105,
         txHash: '0x123456',
         eventIndex: 1,
         timestamp: '2026-10-17T12:00:00Z',
      };

      await processFeeAdjustedEvents([event]);

      expect(mockPrisma.creatorProfile.findFirst).toHaveBeenCalledWith({
         where: { OR: [{ id: KEY_ID }, { handle: KEY_ID }] },
         select: { id: true },
      });

      expect(mockPrisma.keyFeeHistory.upsert).toHaveBeenCalledWith({
         where: {
            txHash_eventIndex: {
               txHash: '0x123456',
               eventIndex: 1,
            },
         },
         create: {
            keyId: KEY_ID,
            feeBps: 300,
            previousFeeBps: 400,
            volumeBracket: 'TIER_3',
            rolling24hVolume: '5500000000',
            ledger: 105,
            txHash: '0x123456',
            eventIndex: 1,
            timestamp: new Date('2026-10-17T12:00:00Z'),
         },
         update: {
            feeBps: 300,
            previousFeeBps: 400,
            volumeBracket: 'TIER_3',
            rolling24hVolume: '5500000000',
            timestamp: new Date('2026-10-17T12:00:00Z'),
         },
      });

      expect(mockInvalidateCache).toHaveBeenCalledWith(KEY_ID);
   });

   it('skips non-FeeAdjusted events', async () => {
      await processFeeAdjustedEvents([
         {
            eventType: 'OTHER_EVENT' as any,
            txHash: '0xabc',
            eventIndex: 0,
         } as any,
      ]);

      expect(mockPrisma.keyFeeHistory.upsert).not.toHaveBeenCalled();
      expect(mockInvalidateCache).not.toHaveBeenCalled();
   });

   it('skips events missing required fields', async () => {
      await processFeeAdjustedEvents([
         {
            eventType: 'FeeAdjusted',
            keyId: KEY_ID,
            // missing feeBps
            txHash: '0xabc',
            eventIndex: 0,
            ledger: 100,
         } as any,
      ]);

      expect(mockPrisma.keyFeeHistory.upsert).not.toHaveBeenCalled();
      expect(mockInvalidateCache).not.toHaveBeenCalled();
   });
});
