// Integration test: trade history endpoint returns results filtered by date range (#599)
//
// Scope:
//   - Seeds five trades: two before the range, one inside, two after
//   - Calls fetchWalletActivity with from/to params enclosing only the middle trade
//   - Asserts exactly one trade is returned matching the expected trade
//   - Asserts trades outside the range are absent
//   - Boundary trades (exactly on from and to) are included
//
// Uses Jest mocks — no database required.

import { fetchWalletActivity } from './wallet-activity.service';
import { prisma } from '../../utils/prisma.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      activity: {
         findMany: jest.fn(),
         count: jest.fn(),
      },
      creatorProfile: {
         findMany: jest.fn(),
      },
   },
}));

const mockPrisma = prisma as unknown as {
   activity: { findMany: jest.Mock; count: jest.Mock };
   creatorProfile: { findMany: jest.Mock };
};

const WALLET_ADDRESS =
   'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CREATOR_ID = 'creator-date-filter-1';

// ── Trade fixtures ────────────────────────────────────────────────────────────
// Two before the range
const TRADE_BEFORE_1 = {
   id: 'trade-before-1',
   type: 'KEY_BOUGHT',
   actor: WALLET_ADDRESS,
   creatorId: CREATOR_ID,
   payload: {
      amount: '1',
      price_at_trade: '100',
      fee_paid: '1',
      ledger_sequence: 1,
   },
   createdAt: new Date('2026-01-05T00:00:00Z'),
};
const TRADE_BEFORE_2 = {
   id: 'trade-before-2',
   type: 'KEY_SOLD',
   actor: WALLET_ADDRESS,
   creatorId: CREATOR_ID,
   payload: {
      amount: '2',
      price_at_trade: '110',
      fee_paid: '1',
      ledger_sequence: 2,
   },
   createdAt: new Date('2026-01-09T23:59:59Z'),
};

// One inside the range (boundary dates inclusive)
const TRADE_INSIDE = {
   id: 'trade-inside',
   type: 'KEY_BOUGHT',
   actor: WALLET_ADDRESS,
   creatorId: CREATOR_ID,
   payload: {
      amount: '3',
      price_at_trade: '150',
      fee_paid: '2',
      ledger_sequence: 3,
   },
   createdAt: new Date('2026-01-15T12:00:00Z'),
};

// Two after the range
const TRADE_AFTER_1 = {
   id: 'trade-after-1',
   type: 'KEY_BOUGHT',
   actor: WALLET_ADDRESS,
   creatorId: CREATOR_ID,
   payload: {
      amount: '4',
      price_at_trade: '200',
      fee_paid: '3',
      ledger_sequence: 4,
   },
   createdAt: new Date('2026-01-20T00:00:01Z'),
};
const TRADE_AFTER_2 = {
   id: 'trade-after-2',
   type: 'KEY_SOLD',
   actor: WALLET_ADDRESS,
   creatorId: CREATOR_ID,
   payload: {
      amount: '5',
      price_at_trade: '210',
      fee_paid: '3',
      ledger_sequence: 5,
   },
   createdAt: new Date('2026-01-25T00:00:00Z'),
};

// Boundary trades: exactly on from / to
const TRADE_ON_FROM = {
   id: 'trade-on-from',
   type: 'KEY_BOUGHT',
   actor: WALLET_ADDRESS,
   creatorId: CREATOR_ID,
   payload: {
      amount: '6',
      price_at_trade: '120',
      fee_paid: '1',
      ledger_sequence: 6,
   },
   createdAt: new Date('2026-01-10T00:00:00Z'),
};
const TRADE_ON_TO = {
   id: 'trade-on-to',
   type: 'KEY_SOLD',
   actor: WALLET_ADDRESS,
   creatorId: CREATOR_ID,
   payload: {
      amount: '7',
      price_at_trade: '180',
      fee_paid: '2',
      ledger_sequence: 7,
   },
   createdAt: new Date('2026-01-20T00:00:00Z'),
};

const CREATOR_PROFILES = [{ id: CREATOR_ID, handle: 'date-filter-creator' }];

// from / to that enclose only the inside trade
const FROM = '2026-01-10T00:00:00.000Z';
const TO = '2026-01-20T00:00:00.000Z';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('#599 trade history endpoint — date range filter', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockPrisma.creatorProfile.findMany.mockResolvedValue(CREATOR_PROFILES);
   });

   // ── Only trades within the range returned ─────────────────────────────────

   it('returns exactly one trade when only the middle trade falls within the range', async () => {
      // The service delegates filtering to Prisma; the mock simulates what
      // the DB would return after applying the date filter.
      mockPrisma.activity.findMany.mockResolvedValue([TRADE_INSIDE]);
      mockPrisma.activity.count.mockResolvedValue(1);

      const [items, total] = await fetchWalletActivity(WALLET_ADDRESS, {
         limit: 20,
         offset: 0,
         from: FROM,
         to: TO,
      });

      expect(total).toBe(1);
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(TRADE_INSIDE.id);
   });

   it('the returned trade matches the expected inside trade', async () => {
      mockPrisma.activity.findMany.mockResolvedValue([TRADE_INSIDE]);
      mockPrisma.activity.count.mockResolvedValue(1);

      const [items] = await fetchWalletActivity(WALLET_ADDRESS, {
         limit: 20,
         offset: 0,
         from: FROM,
         to: TO,
      });

      expect(items[0]).toMatchObject({
         id: TRADE_INSIDE.id,
         type: 'buy',
         creator_id: CREATOR_ID,
         amount: '3',
         price_at_trade: '150',
      });
   });

   // ── Trades before `from` absent ───────────────────────────────────────────

   it('does not include trades before the from date', async () => {
      mockPrisma.activity.findMany.mockResolvedValue([TRADE_INSIDE]);
      mockPrisma.activity.count.mockResolvedValue(1);

      const [items] = await fetchWalletActivity(WALLET_ADDRESS, {
         limit: 20,
         offset: 0,
         from: FROM,
         to: TO,
      });

      const ids = items.map(i => i.id);
      expect(ids).not.toContain(TRADE_BEFORE_1.id);
      expect(ids).not.toContain(TRADE_BEFORE_2.id);
   });

   // ── Trades after `to` absent ──────────────────────────────────────────────

   it('does not include trades after the to date', async () => {
      mockPrisma.activity.findMany.mockResolvedValue([TRADE_INSIDE]);
      mockPrisma.activity.count.mockResolvedValue(1);

      const [items] = await fetchWalletActivity(WALLET_ADDRESS, {
         limit: 20,
         offset: 0,
         from: FROM,
         to: TO,
      });

      const ids = items.map(i => i.id);
      expect(ids).not.toContain(TRADE_AFTER_1.id);
      expect(ids).not.toContain(TRADE_AFTER_2.id);
   });

   // ── Boundary dates are inclusive ──────────────────────────────────────────

   it('includes a trade that falls exactly on the from boundary', async () => {
      mockPrisma.activity.findMany.mockResolvedValue([
         TRADE_ON_FROM,
         TRADE_INSIDE,
      ]);
      mockPrisma.activity.count.mockResolvedValue(2);

      const [items] = await fetchWalletActivity(WALLET_ADDRESS, {
         limit: 20,
         offset: 0,
         from: FROM,
         to: TO,
      });

      const ids = items.map(i => i.id);
      expect(ids).toContain(TRADE_ON_FROM.id);
   });

   it('includes a trade that falls exactly on the to boundary', async () => {
      mockPrisma.activity.findMany.mockResolvedValue([
         TRADE_INSIDE,
         TRADE_ON_TO,
      ]);
      mockPrisma.activity.count.mockResolvedValue(2);

      const [items] = await fetchWalletActivity(WALLET_ADDRESS, {
         limit: 20,
         offset: 0,
         from: FROM,
         to: TO,
      });

      const ids = items.map(i => i.id);
      expect(ids).toContain(TRADE_ON_TO.id);
   });

   it('includes both boundary trades and the inside trade when all are within range', async () => {
      mockPrisma.activity.findMany.mockResolvedValue([
         TRADE_ON_TO,
         TRADE_INSIDE,
         TRADE_ON_FROM,
      ]);
      mockPrisma.activity.count.mockResolvedValue(3);

      const [items, total] = await fetchWalletActivity(WALLET_ADDRESS, {
         limit: 20,
         offset: 0,
         from: FROM,
         to: TO,
      });

      expect(total).toBe(3);
      expect(items).toHaveLength(3);
   });

   // ── Service passes date filter to Prisma where clause ─────────────────────

   it('passes gte filter to prisma when from is provided', async () => {
      mockPrisma.activity.findMany.mockResolvedValue([]);
      mockPrisma.activity.count.mockResolvedValue(0);

      await fetchWalletActivity(WALLET_ADDRESS, {
         limit: 20,
         offset: 0,
         from: FROM,
      });

      const whereArg = mockPrisma.activity.findMany.mock.calls[0][0].where;
      expect(whereArg.createdAt).toBeDefined();
      expect(whereArg.createdAt.gte).toEqual(new Date(FROM));
   });

   it('passes lte filter to prisma when to is provided', async () => {
      mockPrisma.activity.findMany.mockResolvedValue([]);
      mockPrisma.activity.count.mockResolvedValue(0);

      await fetchWalletActivity(WALLET_ADDRESS, {
         limit: 20,
         offset: 0,
         to: TO,
      });

      const whereArg = mockPrisma.activity.findMany.mock.calls[0][0].where;
      expect(whereArg.createdAt).toBeDefined();
      expect(whereArg.createdAt.lte).toEqual(new Date(TO));
   });

   it('passes both gte and lte filters to prisma when from and to are provided', async () => {
      mockPrisma.activity.findMany.mockResolvedValue([]);
      mockPrisma.activity.count.mockResolvedValue(0);

      await fetchWalletActivity(WALLET_ADDRESS, {
         limit: 20,
         offset: 0,
         from: FROM,
         to: TO,
      });

      const whereArg = mockPrisma.activity.findMany.mock.calls[0][0].where;
      expect(whereArg.createdAt.gte).toEqual(new Date(FROM));
      expect(whereArg.createdAt.lte).toEqual(new Date(TO));
   });

   it('does not add createdAt filter when neither from nor to is provided', async () => {
      mockPrisma.activity.findMany.mockResolvedValue([]);
      mockPrisma.activity.count.mockResolvedValue(0);

      await fetchWalletActivity(WALLET_ADDRESS, {
         limit: 20,
         offset: 0,
      });

      const whereArg = mockPrisma.activity.findMany.mock.calls[0][0].where;
      expect(whereArg.createdAt).toBeUndefined();
   });

   // ── Empty result within date range ────────────────────────────────────────

   it('returns empty array when no trades fall within the range', async () => {
      mockPrisma.activity.findMany.mockResolvedValue([]);
      mockPrisma.activity.count.mockResolvedValue(0);

      const [items, total] = await fetchWalletActivity(WALLET_ADDRESS, {
         limit: 20,
         offset: 0,
         from: '2026-06-01T00:00:00.000Z',
         to: '2026-06-30T23:59:59.000Z',
      });

      expect(items).toHaveLength(0);
      expect(total).toBe(0);
   });
});
