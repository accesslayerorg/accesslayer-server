// src/modules/creators/creator-list-price-filter.integration.test.ts
// Integration tests for #419 — min_price and max_price filtering.

import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';

const USER_IDS = ['price-filter-user-1', 'price-filter-user-2', 'price-filter-user-3'];
const HANDLES = ['price-filter-creator-1', 'price-filter-creator-2', 'price-filter-creator-3'];

describe('#419 min_price and max_price filtering', () => {
  let creatorIds: string[];

  beforeAll(async () => {
    creatorIds = [];

    for (let i = 0; i < 3; i++) {
      await prisma.user.upsert({
        where: { id: USER_IDS[i] },
        create: {
          id: USER_IDS[i],
          email: `price-filter-${i}@example.test`,
          passwordHash: 'dummy-hash',
          firstName: 'Price',
          lastName: `Filter ${i}`,
        },
        update: {},
      });

      const creator = await prisma.creatorProfile.upsert({
        where: { userId: USER_IDS[i] },
        create: {
          userId: USER_IDS[i],
          handle: HANDLES[i],
          displayName: `Creator ${i}`,
        },
        update: {},
      });

      creatorIds.push(creator.id);
    }

    // Seed price snapshots: 1M, 3M, 5M stroops
    const prices = [1_000_000n, 3_000_000n, 5_000_000n];
    for (let i = 0; i < 3; i++) {
      await prisma.creatorPriceSnapshot.upsert({
        where: { creatorId: creatorIds[i] },
        create: {
          creatorId: creatorIds[i],
          currentPrice: prices[i],
          price24hAgo: prices[i],
          lastTradeAt: new Date(),
        },
        update: {
          currentPrice: prices[i],
          price24hAgo: prices[i],
          lastTradeAt: new Date(),
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.creatorPriceSnapshot.deleteMany({
      where: { creatorId: { in: creatorIds } },
    });
    await prisma.creatorProfile.deleteMany({
      where: { handle: { in: HANDLES } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: USER_IDS } },
    });
    await prisma.$disconnect();
  });

  it('minPrice alone filters out creators below the value', async () => {
    const res = await supertest(app).get('/api/v1/creators?minPrice=2000000');
    expect(res.status).toBe(200);

    const ids = (res.body.data.items as any[])
      .filter((c: any) => creatorIds.includes(c.id))
      .map((c: any) => c.id);

    // Only creators with price >= 2M (creators 1 and 2)
    expect(ids).toContain(creatorIds[1]); // 3M
    expect(ids).toContain(creatorIds[2]); // 5M
    expect(ids).not.toContain(creatorIds[0]); // 1M
  });

  it('maxPrice alone filters out creators above the value', async () => {
    const res = await supertest(app).get('/api/v1/creators?maxPrice=4000000');
    expect(res.status).toBe(200);

    const ids = (res.body.data.items as any[])
      .filter((c: any) => creatorIds.includes(c.id))
      .map((c: any) => c.id);

    // Only creators with price <= 4M (creators 0 and 1)
    expect(ids).toContain(creatorIds[0]); // 1M
    expect(ids).toContain(creatorIds[1]); // 3M
    expect(ids).not.toContain(creatorIds[2]); // 5M
  });

  it('both params together return only creators within range (inclusive)', async () => {
    const res = await supertest(app).get(
      '/api/v1/creators?minPrice=2000000&maxPrice=4000000'
    );
    expect(res.status).toBe(200);

    const ids = (res.body.data.items as any[])
      .filter((c: any) => creatorIds.includes(c.id))
      .map((c: any) => c.id);

    // Only creator 1 (3M) is in range [2M, 4M]
    expect(ids).toContain(creatorIds[1]);
    expect(ids).not.toContain(creatorIds[0]);
    expect(ids).not.toContain(creatorIds[2]);
  });

  it('returns 400 when minPrice > maxPrice', async () => {
    const res = await supertest(app).get(
      '/api/v1/creators?minPrice=5000000&maxPrice=1000000'
    );
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toBe('Invalid query parameters');
    expect(res.body.error.details[0].field).toBe('minPrice');
  });

  it('combines correctly with sort and pagination', async () => {
    const res = await supertest(app).get(
      '/api/v1/creators?minPrice=1000000&maxPrice=5000000&limit=10&offset=0&sort=createdAt&order=desc'
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.meta.limit).toBe(10);
    expect(res.body.data.meta.offset).toBe(0);
  });

  it('combines correctly with verified filter', async () => {
    // Mark creator 1 as verified
    await prisma.creatorProfile.update({
      where: { id: creatorIds[1] },
      data: { isVerified: true },
    });

    const res = await supertest(app).get(
      '/api/v1/creators?minPrice=1000000&maxPrice=5000000&verified=true'
    );
    expect(res.status).toBe(200);

    const ids = (res.body.data.items as any[])
      .filter((c: any) => creatorIds.includes(c.id))
      .map((c: any) => c.id);

    // Only verified creator 1 within price range
    expect(ids).toContain(creatorIds[1]);
    expect(ids).not.toContain(creatorIds[0]);
    expect(ids).not.toContain(creatorIds[2]);

    // Cleanup
    await prisma.creatorProfile.update({
      where: { id: creatorIds[1] },
      data: { isVerified: false },
    });
  });
});
