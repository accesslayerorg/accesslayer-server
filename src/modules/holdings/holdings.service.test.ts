// src/modules/holdings/holdings.service.test.ts
// Unit tests for the holdings view (last_buy_timestamp, lockup, sorting).

import { getHoldings } from './holdings.service';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      keyOwnership: { findMany: jest.fn() },
      creatorProfile: { findMany: jest.fn() },
      trade: { findMany: jest.fn(), findFirst: jest.fn() },
   },
}));

jest.mock('../../config', () => ({
   envConfig: { KEY_LOCKUP_DURATION_MS: 1000 },
}));

import { prisma } from '../../utils/prisma.utils';

const ownershipFind = prisma.keyOwnership.findMany as jest.Mock;
const profileFind = prisma.creatorProfile.findMany as jest.Mock;
const tradeFindMany = prisma.trade.findMany as jest.Mock;
const tradeFindFirst = prisma.trade.findFirst as jest.Mock;

describe('getHoldings', () => {
   afterEach(() => jest.clearAllMocks());

   it('returns an empty array when the wallet owns nothing', async () => {
      ownershipFind.mockResolvedValue([]);
      const result = await getHoldings('W1');
      expect(result).toEqual([]);
   });

   it('includes last_buy_timestamp and lockup_expires_at and sorts by value desc', async () => {
      ownershipFind.mockResolvedValue([
         { ownerAddress: 'W1', creatorId: 'k1', balance: '5' },
         { ownerAddress: 'W1', creatorId: 'k2', balance: '2' },
      ]);
      profileFind.mockResolvedValue([
         { id: 'k1', displayName: 'Creator One', handle: 'one', avatarUrl: 'a1' },
         { id: 'k2', displayName: 'Creator Two', handle: 'two', avatarUrl: null },
      ]);
      tradeFindMany.mockResolvedValue([
         { keyId: 'k1', side: 'BUY', amount: '5', price: '2', createdAt: new Date('2024-01-01T00:00:00Z') },
         { keyId: 'k2', side: 'BUY', amount: '2', price: '10', createdAt: new Date('2024-02-01T00:00:00Z') },
      ]);
      tradeFindFirst.mockImplementation(async (q: any) => {
         if (q.where.keyId === 'k1') return { price: '2' };
         return { price: '10' };
      });

      const result = await getHoldings('W1');

      expect(result).toHaveLength(2);
      // k2 value = 2 * 10 = 20; k1 value = 5 * 2 = 10 => k2 first.
      expect(result[0].keyId).toBe('k2');
      expect(result[0].currentValue).toBe(20);
      expect(result[0].last_buy_timestamp).toBe('2024-02-01T00:00:00.000Z');
      expect(result[0].lockup_expires_at).toBe(
         new Date(new Date('2024-02-01T00:00:00Z').getTime() + 1000).toISOString()
      );
      expect(result[1].keyId).toBe('k1');
      // cost basis k1 = 5 * 2 = 10; unrealised = currentValue(10) - 10 = 0
      expect(result[1].costBasis).toBe(10);
      expect(result[1].unrealisedPnl).toBe(0);
   });
});
