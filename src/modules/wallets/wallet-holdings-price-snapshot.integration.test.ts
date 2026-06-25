// Integration test: wallet holdings total value recalculated after price snapshot update (#470)
//
// Covers: total_value and current_price reflect the current price snapshot,
// both update correctly when the snapshot price changes, null when no snapshot exists,
// and multi-holding aggregation is correct.
// Uses Jest mocks — no database required.

import { fetchWalletHoldings } from './wallet-holdings.service';
import { prisma } from '../../utils/prisma.utils';

jest.mock('../../utils/prisma.utils', () => ({
    prisma: {
        keyOwnership: {
            findMany: jest.fn(),
        },
        creatorProfile: {
            findMany: jest.fn(),
        },
        creatorPriceSnapshot: {
            findMany: jest.fn(),
        },
    },
}));

const mockPrisma = prisma as unknown as {
    keyOwnership: { findMany: jest.Mock };
    creatorProfile: { findMany: jest.Mock };
    creatorPriceSnapshot: { findMany: jest.Mock };
};

const WALLET_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CREATOR_ID = 'creator-snap-test-1';

describe('Holdings total_value recalculated after price snapshot update', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        mockPrisma.keyOwnership.findMany.mockResolvedValue([
            {
                ownerAddress: WALLET_ADDRESS,
                creatorId: CREATOR_ID,
                balance: '5',
                createdAt: new Date('2026-01-01T00:00:00Z'),
            },
        ]);
        mockPrisma.creatorProfile.findMany.mockResolvedValue([
            { id: CREATOR_ID, handle: 'snap-creator' },
        ]);
    });

    it('total_value reflects the initial price snapshot', async () => {
        mockPrisma.creatorPriceSnapshot.findMany.mockResolvedValue([
            { creatorId: CREATOR_ID, currentPrice: BigInt(1000) },
        ]);

        const [items, total] = await fetchWalletHoldings(WALLET_ADDRESS);

        expect(total).toBe(1);
        expect(items[0].current_price).toBe('1000');
        expect(items[0].total_value).toBe('5000');
    });

    it('total_value and current_price update after price snapshot changes', async () => {
        mockPrisma.creatorPriceSnapshot.findMany.mockResolvedValue([
            { creatorId: CREATOR_ID, currentPrice: BigInt(1000) },
        ]);
        const [initialItems] = await fetchWalletHoldings(WALLET_ADDRESS);
        const initialCurrentPrice = initialItems[0].current_price;
        const initialTotalValue = initialItems[0].total_value;

        expect(initialCurrentPrice).toBe('1000');
        expect(initialTotalValue).toBe('5000');

        mockPrisma.creatorPriceSnapshot.findMany.mockResolvedValue([
            { creatorId: CREATOR_ID, currentPrice: BigInt(2500) },
        ]);
        const [updatedItems] = await fetchWalletHoldings(WALLET_ADDRESS);

        expect(updatedItems[0].current_price).toBe('2500');
        expect(updatedItems[0].total_value).toBe('12500');
        expect(updatedItems[0].current_price).not.toBe(initialCurrentPrice);
        expect(updatedItems[0].total_value).not.toBe(initialTotalValue);
    });

    it('current_price and total_value are null when no snapshot exists for the creator', async () => {
        mockPrisma.creatorPriceSnapshot.findMany.mockResolvedValue([]);

        const [items] = await fetchWalletHoldings(WALLET_ADDRESS);

        expect(items[0].current_price).toBeNull();
        expect(items[0].total_value).toBeNull();
    });

    it('total_value is computed per-holding when wallet has multiple holdings', async () => {
        mockPrisma.keyOwnership.findMany.mockResolvedValue([
            {
                ownerAddress: WALLET_ADDRESS,
                creatorId: 'creator-snap-a',
                balance: '3',
                createdAt: new Date('2026-01-01T00:00:00Z'),
            },
            {
                ownerAddress: WALLET_ADDRESS,
                creatorId: 'creator-snap-b',
                balance: '2',
                createdAt: new Date('2026-01-02T00:00:00Z'),
            },
        ]);
        mockPrisma.creatorProfile.findMany.mockResolvedValue([
            { id: 'creator-snap-a', handle: 'snap-a' },
            { id: 'creator-snap-b', handle: 'snap-b' },
        ]);
        mockPrisma.creatorPriceSnapshot.findMany.mockResolvedValue([
            { creatorId: 'creator-snap-a', currentPrice: BigInt(100) },
            { creatorId: 'creator-snap-b', currentPrice: BigInt(200) },
        ]);

        const [items, total] = await fetchWalletHoldings(WALLET_ADDRESS);

        expect(total).toBe(2);
        expect(items[0].current_price).toBe('100');
        expect(items[0].total_value).toBe('300');
        expect(items[1].current_price).toBe('200');
        expect(items[1].total_value).toBe('400');
    });

    it('total_value for each holding updates independently when snapshot changes', async () => {
        mockPrisma.keyOwnership.findMany.mockResolvedValue([
            {
                ownerAddress: WALLET_ADDRESS,
                creatorId: 'creator-snap-a',
                balance: '3',
                createdAt: new Date('2026-01-01T00:00:00Z'),
            },
            {
                ownerAddress: WALLET_ADDRESS,
                creatorId: 'creator-snap-b',
                balance: '2',
                createdAt: new Date('2026-01-02T00:00:00Z'),
            },
        ]);
        mockPrisma.creatorProfile.findMany.mockResolvedValue([
            { id: 'creator-snap-a', handle: 'snap-a' },
            { id: 'creator-snap-b', handle: 'snap-b' },
        ]);

        mockPrisma.creatorPriceSnapshot.findMany.mockResolvedValue([
            { creatorId: 'creator-snap-a', currentPrice: BigInt(100) },
            { creatorId: 'creator-snap-b', currentPrice: BigInt(200) },
        ]);
        const [before] = await fetchWalletHoldings(WALLET_ADDRESS);

        mockPrisma.creatorPriceSnapshot.findMany.mockResolvedValue([
            { creatorId: 'creator-snap-a', currentPrice: BigInt(150) },
            { creatorId: 'creator-snap-b', currentPrice: BigInt(200) },
        ]);
        const [after] = await fetchWalletHoldings(WALLET_ADDRESS);

        expect(before[0].total_value).toBe('300');
        expect(after[0].total_value).toBe('450');
        expect(before[1].total_value).toBe(after[1].total_value);
    });

    it('returns empty items for a wallet with no holdings', async () => {
        mockPrisma.keyOwnership.findMany.mockResolvedValue([]);

        const [items, total] = await fetchWalletHoldings(WALLET_ADDRESS);

        expect(total).toBe(0);
        expect(items).toEqual([]);
    });
});
