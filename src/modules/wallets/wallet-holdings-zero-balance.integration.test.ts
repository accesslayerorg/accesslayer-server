// Integration test: wallet holdings endpoint excludes zero-balance entries (#484)
//
// Covers: a wallet with one positive-balance and one zero-balance ownership record
// should only return the positive-balance creator in the response.
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
const CREATOR_WITH_BALANCE = 'creator-positive-balance';
const CREATOR_ZERO_BALANCE = 'creator-zero-balance';

describe('GET /wallets/:address/holdings — zero-balance exclusion', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        // The service filters balance > 0 at the DB layer, so the mock returns
        // only the positive-balance row (simulating what prisma would return
        // with the `balance: { gt: 0 }` where clause).
        mockPrisma.keyOwnership.findMany.mockResolvedValue([
            {
                ownerAddress: WALLET_ADDRESS,
                creatorId: CREATOR_WITH_BALANCE,
                balance: '3',
                createdAt: new Date('2026-01-01T00:00:00Z'),
            },
        ]);

        mockPrisma.creatorProfile.findMany.mockResolvedValue([
            { id: CREATOR_WITH_BALANCE, handle: 'active-creator' },
        ]);

        mockPrisma.creatorPriceSnapshot.findMany.mockResolvedValue([
            { creatorId: CREATOR_WITH_BALANCE, currentPrice: BigInt(500) },
        ]);
    });

    it('excludes zero-balance creator from response', async () => {
        const [items] = await fetchWalletHoldings(WALLET_ADDRESS);

        const returnedIds = items.map((item) => item.creator_id);
        expect(returnedIds).not.toContain(CREATOR_ZERO_BALANCE);
    });

    it('includes positive-balance creator with correct balance', async () => {
        const [items] = await fetchWalletHoldings(WALLET_ADDRESS);

        expect(items[0].creator_id).toBe(CREATOR_WITH_BALANCE);
        expect(items[0].key_count).toBe('3');
    });

    it('response length matches only non-zero entries', async () => {
        const [items, total] = await fetchWalletHoldings(WALLET_ADDRESS);

        expect(items).toHaveLength(1);
        expect(total).toBe(1);
    });

    it('service queries DB with balance > 0 filter', async () => {
        await fetchWalletHoldings(WALLET_ADDRESS);

        expect(mockPrisma.keyOwnership.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    balance: { gt: 0 },
                }),
            })
        );
    });
});
