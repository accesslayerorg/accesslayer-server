// src/modules/creators/creator-list-price-filtered-total.integration.test.ts

import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';

const USER_IDS = [
  'filtered-total-user-1',
  'filtered-total-user-2',
  'filtered-total-user-3',
  'filtered-total-user-4',
  'filtered-total-user-5',
];

const HANDLES = [
  'filtered-total-creator-1',
  'filtered-total-creator-2',
  'filtered-total-creator-3',
  'filtered-total-creator-4',
  'filtered-total-creator-5',
];

describe('GET /api/v1/creators — filtered total count with price range', () => {
  let creatorIds: string[] = [];

  beforeAll(async () => {
    // Ensure database is completely clean of any conflicting data
    await prisma.keyOwnership.deleteMany({});
    await prisma.creatorPriceSnapshot.deleteMany({});
    await prisma.creatorProfile.deleteMany({});
    await prisma.user.deleteMany({});

    creatorIds = [];

    // Seed exactly 5 users and creators
    for (let i = 0; i < 5; i++) {
      await prisma.user.create({
        data: {
          id: USER_IDS[i],
          email: `filtered-total-${i}@example.test`,
          passwordHash: 'dummy-hash',
          firstName: 'Filtered',
          lastName: `Total ${i}`,
        },
      });

      const creator = await prisma.creatorProfile.create({
        data: {
          userId: USER_IDS[i],
          handle: HANDLES[i],
          displayName: `Creator ${i}`,
        },
      });

      creatorIds.push(creator.id);
    }

    // Seed exactly 5 creators with varied prices: 1M, 2M, 3M, 4M, 5M stroops
    const prices = [1_000_000n, 2_000_000n, 3_000_000n, 4_000_000n, 5_000_000n];
    for (let i = 0; i < 5; i++) {
      await prisma.creatorPriceSnapshot.create({
        data: {
          creatorId: creatorIds[i],
          currentPrice: prices[i],
          price24hAgo: prices[i],
          lastTradeAt: new Date(),
        },
      });
    }
  });

  afterAll(async () => {
    // Teardown
    await prisma.creatorPriceSnapshot.deleteMany({
      where: { creatorId: { in: creatorIds } },
    });
    await prisma.creatorProfile.deleteMany({
      where: { id: { in: creatorIds } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: USER_IDS } },
    });
    await prisma.$disconnect();
  });

  it('should verify that meta.total reflects the filtered creator count and matches the response data length when a price range is applied', async () => {
    // Apply a price range filter matching exactly three creators: [2M, 4M] (prices 2M, 3M, 4M)
    const res = await supertest(app).get('/api/v1/creators?minPrice=2000000&maxPrice=4000000');
    expect(res.status).toBe(200);

    const response = {
      data: res.body.data.items,
      meta: res.body.data.meta,
    };
    const { meta } = response;

    // Assert requirements:
    // - meta.total === 3
    // - response.data.length === 3
    // - response.data.length === response.meta.total
    expect(meta.total).toBe(3);
    expect(response.data.length).toBe(3);
    expect(response.data.length).toBe(response.meta.total);

    // Verify that meta.total is the filtered count, not the total creator count in the database (5)
    expect(meta.total).not.toBe(5);
  });
});
