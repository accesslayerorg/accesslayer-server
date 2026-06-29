import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';

const PAGE_SIZE = 20;
const TOTAL_HOLDINGS = 50;
const TEST_WALLET_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('GET /api/v1/wallets/:address/holdings pagination', () => {
    let creatorIds: string[] = [];

    beforeAll(async () => {
        // Create user
        const user = await prisma.user.create({
            data: {
                id: 'wallet-holdings-pag-test-user',
                email: 'wallet-holdings-pag@example.com',
                passwordHash: 'dummy-hash',
                firstName: 'Wallet',
                lastName: 'HoldingsPagTest',
            },
        });

        // Create creators
        const creators = await Promise.all(
            Array.from({ length: TOTAL_HOLDINGS }).map((_, i) =>
                prisma.creatorProfile.create({
                    data: {
                        userId: user.id,
                        handle: `creator-${i}`,
                        displayName: `Creator ${i}`,
                    },
                })
            )
        );
        creatorIds = creators.map((c) => c.id);

        // Create key ownerships for the test wallet
        await prisma.keyOwnership.createMany({
            data: creatorIds.map((creatorId, i) => ({
                ownerAddress: TEST_WALLET_ADDRESS,
                creatorId: creatorId,
                balance: TOTAL_HOLDINGS - i,
                createdAt: new Date(`2026-06-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`),
            })),
        });
    });

    afterAll(async () => {
        // Cleanup
        await prisma.keyOwnership.deleteMany({
            where: { ownerAddress: TEST_WALLET_ADDRESS },
        });
        await prisma.creatorProfile.deleteMany({
            where: { id: { in: creatorIds } },
        });
        await prisma.user.delete({
            where: { id: 'wallet-holdings-pag-test-user' },
        });
        await prisma.$disconnect();
    });

    it('paginates correctly across multiple pages with no duplicates and all items present', async () => {
        const allPageItems: string[][] = [];
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
            const res = await supertest(app)
                .get(`/api/v1/wallets/${TEST_WALLET_ADDRESS}/holdings?limit=${PAGE_SIZE}&offset=${offset}`);

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);

            const items = res.body.data.items;
            const meta = res.body.data.meta;

            allPageItems.push(items.map((item: any) => item.creator_id));
            hasMore = meta.hasMore;
            offset += items.length;
        }

        const seenAcrossAllPages = allPageItems.flat();
        expect(new Set(seenAcrossAllPages).size).toBe(TOTAL_HOLDINGS);
        expect(seenAcrossAllPages.length).toBe(TOTAL_HOLDINGS);

        // Check no duplicates between pages
        const page1 = allPageItems[0];
        const page2 = allPageItems[1];
        const overlap = page1.filter((id) => page2.includes(id));
        expect(overlap.length).toBe(0);
    });

    it('final page returns hasMore: false', async () => {
        const res = await supertest(app)
            .get(`/api/v1/wallets/${TEST_WALLET_ADDRESS}/holdings?limit=${PAGE_SIZE}&offset=${40}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.meta.hasMore).toBe(false);
    });
});
