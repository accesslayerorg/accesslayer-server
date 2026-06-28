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
    activity: {
        findMany: jest.Mock;
        count: jest.Mock;
    };
    creatorProfile: {
        findMany: jest.Mock;
    };
};

const WALLET_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const mixedActivities = [
    {
        type: 'KEY_BOUGHT',
        actor: WALLET_ADDRESS,
        creatorId: 'creator-alpha',
        payload: { amount: '2', price_at_trade: '10', fee_paid: '0.1', ledger_sequence: 101 },
        createdAt: new Date('2026-06-01T00:00:00Z'),
    },
    {
        type: 'KEY_SOLD',
        actor: WALLET_ADDRESS,
        creatorId: 'creator-beta',
        payload: { amount: '1', price_at_trade: '8', fee_paid: '0.08', ledger_sequence: 102 },
        createdAt: new Date('2026-06-02T00:00:00Z'),
    },
    {
        type: 'KEY_BOUGHT',
        actor: WALLET_ADDRESS,
        creatorId: 'creator-beta',
        payload: { amount: '3', price_at_trade: '12', fee_paid: '0.12', ledger_sequence: 103 },
        createdAt: new Date('2026-06-03T00:00:00Z'),
    },
];

function matchingActivities(where: { type?: string | { in: string[] } }) {
    if (where.type === 'KEY_BOUGHT') {
        return mixedActivities.filter((activity) => activity.type === 'KEY_BOUGHT');
    }

    if (where.type === 'KEY_SOLD') {
        return mixedActivities.filter((activity) => activity.type === 'KEY_SOLD');
    }

    return mixedActivities;
}

describe('fetchWalletActivity type filter integration', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        mockPrisma.activity.findMany.mockImplementation(({ where }) =>
            Promise.resolve(matchingActivities(where))
        );
        mockPrisma.activity.count.mockImplementation(({ where }) =>
            Promise.resolve(matchingActivities(where).length)
        );
        mockPrisma.creatorProfile.findMany.mockResolvedValue([
            { id: 'creator-alpha', handle: 'alpha' },
            { id: 'creator-beta', handle: 'beta' },
        ]);
    });

    it('returns only buy events when type=buy', async () => {
        const [items, total] = await fetchWalletActivity(WALLET_ADDRESS, {
            type: 'buy',
            limit: 20,
            offset: 0,
        });

        expect(total).toBe(2);
        expect(items).toHaveLength(2);
        expect(items.map((item) => item.type)).toEqual(['buy', 'buy']);
        expect(items.map((item) => item.creator_id)).toEqual(['creator-alpha', 'creator-beta']);
        expect(mockPrisma.activity.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ actor: WALLET_ADDRESS, type: 'KEY_BOUGHT' }),
            })
        );
    });

    it('returns only sell events when type=sell', async () => {
        const [items, total] = await fetchWalletActivity(WALLET_ADDRESS, {
            type: 'sell',
            limit: 20,
            offset: 0,
        });

        expect(total).toBe(1);
        expect(items).toHaveLength(1);
        expect(items.every((item) => item.type === 'sell')).toBe(true);
        expect(items[0].creator_id).toBe('creator-beta');
        expect(mockPrisma.activity.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ actor: WALLET_ADDRESS, type: 'KEY_SOLD' }),
            })
        );
    });

    it('returns the full mixed history when type is omitted', async () => {
        const [items, total] = await fetchWalletActivity(WALLET_ADDRESS, {
            limit: 20,
            offset: 0,
        });

        expect(total).toBe(3);
        expect(items).toHaveLength(3);
        expect(items.map((item) => item.type)).toEqual(['buy', 'sell', 'buy']);
        expect(mockPrisma.activity.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    actor: WALLET_ADDRESS,
                    type: { in: ['KEY_BOUGHT', 'KEY_SOLD'] },
                }),
            })
        );
    });
});
