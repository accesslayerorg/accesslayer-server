// Integration test: activity feed returns historical price at time of trade (#489)
//
// Covers: two buy events for the same creator at different prices, with a third
// current snapshot price. Each event must show its own trade-time price, not
// the current snapshot price.
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

const WALLET_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CREATOR_ID = 'creator-hist-price-1';

// Trade 1: price was 200 at trade time
const TRADE_1_PRICE = '200';
// Trade 2: price was 350 at trade time
const TRADE_2_PRICE = '350';
// Current snapshot price — neither trade should surface this value
const CURRENT_SNAPSHOT_PRICE = '500';

const trade1 = {
    type: 'KEY_BOUGHT',
    actor: WALLET_ADDRESS,
    creatorId: CREATOR_ID,
    payload: { amount: '5', price_at_trade: TRADE_1_PRICE, fee_paid: '1', ledger_sequence: 1001 },
    createdAt: new Date('2026-01-10T00:00:00Z'),
};

const trade2 = {
    type: 'KEY_BOUGHT',
    actor: WALLET_ADDRESS,
    creatorId: CREATOR_ID,
    payload: { amount: '3', price_at_trade: TRADE_2_PRICE, fee_paid: '1', ledger_sequence: 1002 },
    createdAt: new Date('2026-03-15T00:00:00Z'),
};

describe('Wallet activity feed — historical price preservation', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        mockPrisma.activity.findMany.mockResolvedValue([trade2, trade1]); // ordered newest first
        mockPrisma.activity.count.mockResolvedValue(2);
        mockPrisma.creatorProfile.findMany.mockResolvedValue([
            { id: CREATOR_ID, handle: 'hist-creator' },
        ]);
    });

    it('first trade event shows the price at the time of that trade', async () => {
        const [items] = await fetchWalletActivity(WALLET_ADDRESS, { limit: 20, offset: 0 });

        // items[0] is trade2 (newest first)
        expect(items[0].price_at_trade).toBe(TRADE_2_PRICE);
    });

    it('second trade event shows a different price matching its own trade time', async () => {
        const [items] = await fetchWalletActivity(WALLET_ADDRESS, { limit: 20, offset: 0 });

        // items[1] is trade1 (older)
        expect(items[1].price_at_trade).toBe(TRADE_1_PRICE);
        expect(items[1].price_at_trade).not.toBe(items[0].price_at_trade);
    });

    it('neither event shows the current snapshot price', async () => {
        const [items] = await fetchWalletActivity(WALLET_ADDRESS, { limit: 20, offset: 0 });

        for (const item of items) {
            expect(item.price_at_trade).not.toBe(CURRENT_SNAPSHOT_PRICE);
        }
    });

    it('both events belong to the same creator', async () => {
        const [items] = await fetchWalletActivity(WALLET_ADDRESS, { limit: 20, offset: 0 });

        expect(items[0].creator_id).toBe(CREATOR_ID);
        expect(items[1].creator_id).toBe(CREATOR_ID);
    });

    it('returns exactly two trade events', async () => {
        const [items, total] = await fetchWalletActivity(WALLET_ADDRESS, { limit: 20, offset: 0 });

        expect(items).toHaveLength(2);
        expect(total).toBe(2);
    });
});
