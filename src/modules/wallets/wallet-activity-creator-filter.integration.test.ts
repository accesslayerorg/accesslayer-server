// Integration test: wallet activity creator_id filter (#476)
//
// Verifies that GET /wallets/:address/activity with creator_id returns only
// trades for the specified creator, excluding trades for all other creators,
// and that combining creator_id + type filters works correctly.

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

const WALLET_ADDRESS = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA';
const CREATOR_A = 'creator-filter-a';
const CREATOR_B = 'creator-filter-b';

const seededActivities = [
  {
    type: 'KEY_BOUGHT',
    actor: WALLET_ADDRESS,
    creatorId: CREATOR_A,
    payload: { amount: '5', price_at_trade: '20', fee_paid: '0.5', ledger_sequence: 201 },
    createdAt: new Date('2026-06-10T00:00:00Z'),
  },
  {
    type: 'KEY_SOLD',
    actor: WALLET_ADDRESS,
    creatorId: CREATOR_A,
    payload: { amount: '2', price_at_trade: '25', fee_paid: '0.4', ledger_sequence: 202 },
    createdAt: new Date('2026-06-11T00:00:00Z'),
  },
  {
    type: 'KEY_BOUGHT',
    actor: WALLET_ADDRESS,
    creatorId: CREATOR_B,
    payload: { amount: '3', price_at_trade: '15', fee_paid: '0.3', ledger_sequence: 203 },
    createdAt: new Date('2026-06-12T00:00:00Z'),
  },
  {
    type: 'KEY_SOLD',
    actor: WALLET_ADDRESS,
    creatorId: CREATOR_B,
    payload: { amount: '1', price_at_trade: '18', fee_paid: '0.2', ledger_sequence: 204 },
    createdAt: new Date('2026-06-13T00:00:00Z'),
  },
];

function applyWhere(where: {
  actor: string;
  creatorId?: string;
  type?: string | { in: string[] };
}) {
  return seededActivities.filter((a) => {
    if (a.actor !== where.actor) return false;
    if (where.creatorId && a.creatorId !== where.creatorId) return false;
    if (where.type) {
      if (typeof where.type === 'string') {
        if (a.type !== where.type) return false;
      } else if (where.type.in && !where.type.in.includes(a.type)) {
        return false;
      }
    }
    return true;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.activity.findMany.mockImplementation(({ where }) =>
    Promise.resolve(applyWhere(where))
  );
  mockPrisma.activity.count.mockImplementation(({ where }) =>
    Promise.resolve(applyWhere(where).length)
  );
  mockPrisma.creatorProfile.findMany.mockResolvedValue([
    { id: CREATOR_A, handle: 'handle-a' },
    { id: CREATOR_B, handle: 'handle-b' },
  ]);
});

describe('fetchWalletActivity — creator_id filter (#476)', () => {
  it('returns only trades for creator A when creator_id=CREATOR_A', async () => {
    const [items, total] = await fetchWalletActivity(WALLET_ADDRESS, {
      creator_id: CREATOR_A,
      limit: 20,
      offset: 0,
    });

    expect(total).toBe(2);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.creator_id === CREATOR_A)).toBe(true);
  });

  it('excludes all trades from creator B when filtering by creator A', async () => {
    const [items] = await fetchWalletActivity(WALLET_ADDRESS, {
      creator_id: CREATOR_A,
      limit: 20,
      offset: 0,
    });

    expect(items.some((i) => i.creator_id === CREATOR_B)).toBe(false);
  });

  it('returns only trades for creator B when creator_id=CREATOR_B', async () => {
    const [items, total] = await fetchWalletActivity(WALLET_ADDRESS, {
      creator_id: CREATOR_B,
      limit: 20,
      offset: 0,
    });

    expect(total).toBe(2);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.creator_id === CREATOR_B)).toBe(true);
  });

  it('excludes all trades from creator A when filtering by creator B', async () => {
    const [items] = await fetchWalletActivity(WALLET_ADDRESS, {
      creator_id: CREATOR_B,
      limit: 20,
      offset: 0,
    });

    expect(items.some((i) => i.creator_id === CREATOR_A)).toBe(false);
  });

  it('combines creator_id and type=buy filters correctly', async () => {
    const [items, total] = await fetchWalletActivity(WALLET_ADDRESS, {
      creator_id: CREATOR_A,
      type: 'buy',
      limit: 20,
      offset: 0,
    });

    expect(total).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0].creator_id).toBe(CREATOR_A);
    expect(items[0].type).toBe('buy');
  });

  it('combines creator_id and type=sell filters correctly', async () => {
    const [items, total] = await fetchWalletActivity(WALLET_ADDRESS, {
      creator_id: CREATOR_B,
      type: 'sell',
      limit: 20,
      offset: 0,
    });

    expect(total).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0].creator_id).toBe(CREATOR_B);
    expect(items[0].type).toBe('sell');
  });

  it('passes creatorId in the where clause when creator_id is provided', async () => {
    await fetchWalletActivity(WALLET_ADDRESS, {
      creator_id: CREATOR_A,
      limit: 20,
      offset: 0,
    });

    expect(mockPrisma.activity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ creatorId: CREATOR_A }),
      })
    );
  });

  it('returns all trades when no creator_id filter is applied', async () => {
    const [items, total] = await fetchWalletActivity(WALLET_ADDRESS, {
      limit: 20,
      offset: 0,
    });

    expect(total).toBe(4);
    expect(items).toHaveLength(4);
  });
});
