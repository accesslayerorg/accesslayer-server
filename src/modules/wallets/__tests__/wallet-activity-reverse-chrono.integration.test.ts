// Integration test: wallet activity feed returns events newest first (#445)
//
// Verifies that fetchWalletActivity delegates ordering to Prisma via
// orderBy: { createdAt: 'desc' } and that the returned items arrive
// in descending timestamp order when Prisma honours that clause.
// Uses Jest mocks — no database required.

import { fetchWalletActivity } from '../wallet-activity.service';
import { prisma } from '../../../utils/prisma.utils';

jest.mock('../../../utils/prisma.utils', () => ({
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
    activity: {
        findMany: jest.Mock;
        count: jest.Mock;
    };
    creatorProfile: {
        findMany: jest.Mock;
    };
};

const WALLET_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// Three activities with timestamps: 2026-06-01 (newest), 2026-03-15, 2026-01-10 (oldest).
// Listed here in the order Prisma would return them when orderBy: { createdAt: 'desc' }
// is applied — newest first.
const activitiesNewestFirst = [
    {
        type: 'KEY_BOUGHT',
        actor: WALLET_ADDRESS,
        creatorId: 'creator-alpha',
        payload: { amount: '3', price_at_trade: '12', fee_paid: '0.12', ledger_sequence: 103 },
        createdAt: new Date('2026-06-01T00:00:00Z'),
    },
    {
        type: 'KEY_SOLD',
        actor: WALLET_ADDRESS,
        creatorId: 'creator-beta',
        payload: { amount: '2', price_at_trade: '10', fee_paid: '0.10', ledger_sequence: 102 },
        createdAt: new Date('2026-03-15T00:00:00Z'),
    },
    {
        type: 'KEY_BOUGHT',
        actor: WALLET_ADDRESS,
        creatorId: 'creator-alpha',
        payload: { amount: '1', price_at_trade: '8', fee_paid: '0.08', ledger_sequence: 101 },
        createdAt: new Date('2026-01-10T00:00:00Z'),
    },
];

// Same three records in a scrambled (insertion-order) sequence.
const activitiesScrambled = [
    activitiesNewestFirst[1], // 2026-03-15
    activitiesNewestFirst[2], // 2026-01-10
    activitiesNewestFirst[0], // 2026-06-01
];

const DEFAULT_QUERY = { limit: 20, offset: 0 };

describe('fetchWalletActivity – reverse chronological ordering (#445)', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        mockPrisma.creatorProfile.findMany.mockResolvedValue([
            { id: 'creator-alpha', handle: 'alpha' },
            { id: 'creator-beta', handle: 'beta' },
        ]);
        mockPrisma.activity.count.mockResolvedValue(activitiesNewestFirst.length);
    });

    // Test 1 – service passes orderBy: { createdAt: 'desc' } to Prisma
    it('calls prisma.activity.findMany with orderBy: { createdAt: "desc" }', async () => {
        mockPrisma.activity.findMany.mockResolvedValue(activitiesNewestFirst);

        await fetchWalletActivity(WALLET_ADDRESS, DEFAULT_QUERY);

        expect(mockPrisma.activity.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                orderBy: { createdAt: 'desc' },
            }),
        );
    });

    // Test 2 – service does NOT reorder rows; the order it returns matches
    // what Prisma hands back (Prisma is the sole owner of sorting).
    it('returns items in the same order Prisma provides (service does not reorder)', async () => {
        // Prisma returns newest-first (as it would with orderBy: desc).
        mockPrisma.activity.findMany.mockResolvedValue(activitiesNewestFirst);

        const [items] = await fetchWalletActivity(WALLET_ADDRESS, DEFAULT_QUERY);

        // The service must not sort; it must preserve Prisma's order.
        expect(items[0].timestamp).toEqual(activitiesNewestFirst[0].createdAt);
        expect(items[1].timestamp).toEqual(activitiesNewestFirst[1].createdAt);
        expect(items[2].timestamp).toEqual(activitiesNewestFirst[2].createdAt);
    });

    // Test 3 – when Prisma returns rows newest-first the items are newest-first
    it('returns items newest-first when prisma returns them in descending order', async () => {
        mockPrisma.activity.findMany.mockResolvedValue(activitiesNewestFirst);

        const [items] = await fetchWalletActivity(WALLET_ADDRESS, DEFAULT_QUERY);

        expect(items).toHaveLength(3);
        // Each timestamp must be >= the one that follows.
        for (let i = 0; i < items.length - 1; i++) {
            expect(items[i].timestamp.getTime()).toBeGreaterThanOrEqual(
                items[i + 1].timestamp.getTime(),
            );
        }
    });

    // Test 4 – explicit timestamp ordering for the three specific dates
    it('events with timestamps 2026-06-01 > 2026-03-15 > 2026-01-10 appear in that order', async () => {
        mockPrisma.activity.findMany.mockResolvedValue(activitiesNewestFirst);

        const [items] = await fetchWalletActivity(WALLET_ADDRESS, DEFAULT_QUERY);

        expect(items[0].timestamp).toEqual(new Date('2026-06-01T00:00:00Z'));
        expect(items[1].timestamp).toEqual(new Date('2026-03-15T00:00:00Z'));
        expect(items[2].timestamp).toEqual(new Date('2026-01-10T00:00:00Z'));
    });

    // Test 5 – zero activity returns empty array
    it('returns an empty items array when there are no activities', async () => {
        mockPrisma.activity.findMany.mockResolvedValue([]);
        mockPrisma.activity.count.mockResolvedValue(0);

        const [items, total] = await fetchWalletActivity(WALLET_ADDRESS, DEFAULT_QUERY);

        expect(items).toEqual([]);
        expect(total).toBe(0);
    });

    // Bonus: even when Prisma hands back rows in scrambled order the service
    // passes through that order unchanged (it trusts Prisma to sort).
    it('does not independently sort: preserves scrambled Prisma output as-is', async () => {
        mockPrisma.activity.findMany.mockResolvedValue(activitiesScrambled);

        const [items] = await fetchWalletActivity(WALLET_ADDRESS, DEFAULT_QUERY);

        expect(items[0].timestamp).toEqual(activitiesScrambled[0].createdAt); // 2026-03-15
        expect(items[1].timestamp).toEqual(activitiesScrambled[1].createdAt); // 2026-01-10
        expect(items[2].timestamp).toEqual(activitiesScrambled[2].createdAt); // 2026-06-01
    });
});
