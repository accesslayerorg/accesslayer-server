// Unit tests: wallet holdings endpoint (Feature: GET /users/:wallet/holdings)
//
// Covers the acceptance criteria:
//   - last_buy_timestamp present on each holding
//   - lockup_expires_at computed as last buy + configured lockup duration
//   - all required fields present per holding
//   - holdings sorted by current value descending
//   - empty array returned when the wallet holds no keys

process.env.LOCKUP_DURATION_SECONDS = '3600';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      keyOwnership: { findMany: jest.fn() },
      creatorProfile: { findMany: jest.fn() },
      activity: { findMany: jest.fn() },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import {
   computeLockupExpiry,
   getWalletHoldings,
} from './holdings.service';

const ownershipFindMany = prisma.keyOwnership.findMany as jest.Mock;
const creatorFindMany = prisma.creatorProfile.findMany as jest.Mock;
const activityFindMany = prisma.activity.findMany as jest.Mock;

const WALLET = 'GA5XIGA5C7GTGTW7ZKJ4YV6OEILUY2Q7YIHZQNNDJUWAVES4O7D5SUK9';

function ownershipRow(overrides: Record<string, unknown> = {}) {
   return {
      creatorId: 'key-1',
      balance: 10,
      costBasis: 2,
      lastBuyAt: new Date('2026-08-20T10:00:00.000Z'),
      ...overrides,
   };
}

describe('getWalletHoldings', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('returns an empty array when the wallet holds no keys', async () => {
      ownershipFindMany.mockResolvedValue([]);

      const holdings = await getWalletHoldings(WALLET);

      expect(holdings).toEqual([]);
      // Short-circuits before touching creators or prices.
      expect(creatorFindMany).not.toHaveBeenCalled();
      expect(activityFindMany).not.toHaveBeenCalled();
   });

   it('includes all required fields plus lockup data per holding', async () => {
      ownershipFindMany.mockResolvedValue([ownershipRow()]);
      creatorFindMany.mockResolvedValue([
         {
            id: 'key-1',
            handle: 'alice',
            displayName: 'Alice',
            avatarUrl: 'https://img/alice.png',
         },
      ]);
      activityFindMany.mockResolvedValue([]);

      const [holding] = await getWalletHoldings(WALLET);

      expect(holding).toMatchObject({
         keyId: 'key-1',
         creatorName: 'Alice',
         avatarUrl: 'https://img/alice.png',
         quantity: 10,
         costBasis: 2,
      });
      expect(holding.last_buy_timestamp).toBe('2026-08-20T10:00:00.000Z');
      // Lockup = last buy + 3600s.
      expect(holding.lockup_expires_at).toBe('2026-08-20T11:00:00.000Z');
      expect(typeof holding.unrealisedPnl).toBe('number');
      expect(typeof holding.currentPrice).toBe('number');
   });

   it('sorts holdings by current value descending', async () => {
      ownershipFindMany.mockResolvedValue([
         // Small position at a high price → lower value.
         ownershipRow({ creatorId: 'key-small', balance: 1, costBasis: 50 }),
         // Large position → highest value.
         ownershipRow({ creatorId: 'key-big', balance: 100, costBasis: 5 }),
      ]);
      creatorFindMany.mockResolvedValue([
         { id: 'key-small', handle: 's', displayName: 'Small', avatarUrl: null },
         { id: 'key-big', handle: 'b', displayName: 'Big', avatarUrl: null },
      ]);
      activityFindMany.mockResolvedValue([]);

      const holdings = await getWalletHoldings(WALLET);

      expect(holdings.map((holding) => holding.keyId)).toEqual([
         'key-big',
         'key-small',
      ]);
   });

   it('uses the latest trade price for currentPrice when available', async () => {
      ownershipFindMany.mockResolvedValue([ownershipRow()]);
      creatorFindMany.mockResolvedValue([
         { id: 'key-1', handle: 'alice', displayName: 'Alice', avatarUrl: null },
      ]);
      activityFindMany.mockResolvedValue([
         { creatorId: 'key-1', payload: { amount: '9.5' } },
      ]);

      const [holding] = await getWalletHoldings(WALLET);

      expect(holding.currentPrice).toBe(9.5);
      // PnL = (9.5 - 2) * 10.
      expect(holding.unrealisedPnl).toBeCloseTo(75, 7);
   });
});

describe('computeLockupExpiry', () => {
   it('returns null when there was no buy', () => {
      expect(computeLockupExpiry(null)).toBeNull();
   });
});
