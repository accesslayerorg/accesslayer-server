// src/modules/trade/trade.service.test.ts
// Unit tests for trade execution and analytics cache invalidation.

import { executeTrade, resolveCreatorId } from './trade.service';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      $transaction: jest.fn(async (cb: any) => cb(prisma)),
      trade: { create: jest.fn() },
      keyOwnership: { upsert: jest.fn() },
      creatorProfile: { findUnique: jest.fn() },
   },
}));

jest.mock('../analytics/analytics.cache', () => ({
   invalidateAnalyticsCache: jest.fn(),
}));

import { prisma } from '../../utils/prisma.utils';
import { invalidateAnalyticsCache } from '../analytics/analytics.cache';

const tradeCreate = prisma.trade.create as jest.Mock;
const ownershipUpsert = prisma.keyOwnership.upsert as jest.Mock;
const profileFind = prisma.creatorProfile.findUnique as jest.Mock;

describe('executeTrade', () => {
   afterEach(() => jest.clearAllMocks());

   it('records the trade, updates ownership and invalidates analytics', async () => {
      tradeCreate.mockResolvedValue({
         id: 't1',
         keyId: 'k1',
         wallet: 'W1',
         side: 'BUY',
         amount: '5',
         price: '2',
         createdAt: new Date('2024-01-01T00:00:00Z'),
      });
      ownershipUpsert.mockResolvedValue({});

      const result = await executeTrade({
         keyId: 'k1',
         creatorId: 'c1',
         wallet: 'W1',
         side: 'BUY',
         amount: 5,
         price: 2,
         txHash: '0x1',
      });

      expect(tradeCreate).toHaveBeenCalledTimes(1);
      expect(ownershipUpsert).toHaveBeenCalledTimes(1);
      expect(invalidateAnalyticsCache).toHaveBeenCalledWith('k1');
      expect(result.amount).toBe(5);
   });
});

describe('resolveCreatorId', () => {
   afterEach(() => jest.clearAllMocks());

   it('returns the profile id when the key exists', async () => {
      profileFind.mockResolvedValue({ id: 'c1' });
      expect(await resolveCreatorId('c1')).toBe('c1');
   });

   it('returns null when the key is unknown', async () => {
      profileFind.mockResolvedValue(null);
      expect(await resolveCreatorId('nope')).toBeNull();
   });
});
