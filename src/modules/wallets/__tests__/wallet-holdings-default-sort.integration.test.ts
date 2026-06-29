// src/modules/wallets/__tests__/wallet-holdings-default-sort.integration.test.ts

import supertest from 'supertest';
import app from '../../../app';
import { prisma } from '../../../utils/prisma.utils';

describe('GET /api/v1/wallets/:address/holdings - default sort order', () => {
  const WALLET_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  const USER_IDS = [
    'wallet-sort-user-1',
    'wallet-sort-user-2',
    'wallet-sort-user-3',
  ];

  const CREATOR_IDS = [
    'wallet-sort-creator-1',
    'wallet-sort-creator-2',
    'wallet-sort-creator-3',
  ];

  beforeAll(async () => {
    // Clean up database tables to avoid tests leaking into each other
    await prisma.keyOwnership.deleteMany({});
    await prisma.creatorPriceSnapshot.deleteMany({});
    await prisma.creatorProfile.deleteMany({});
    await prisma.user.deleteMany({});

    // Create 3 users for the creators
    for (let i = 0; i < 3; i++) {
      await prisma.user.create({
        data: {
          id: USER_IDS[i],
          email: `wallet-sort-user-${i}@example.test`,
          passwordHash: 'dummy-hash',
          firstName: 'Wallet',
          lastName: `Sort ${i}`,
        },
      });
    }

    // Create 3 creators
    for (let i = 0; i < 3; i++) {
      await prisma.creatorProfile.create({
        data: {
          id: CREATOR_IDS[i],
          userId: USER_IDS[i],
          handle: `wallet_sort_creator_${i}`,
          displayName: `Wallet Sort Creator ${i}`,
        },
      });
    }

    // Create price snapshots with different currentPrice (BigInt)
    // Creator 1: price = 100
    // Creator 2: price = 50
    // Creator 3: price = 50
    await prisma.creatorPriceSnapshot.create({
      data: {
        creatorId: CREATOR_IDS[0],
        currentPrice: 100n,
      },
    });
    await prisma.creatorPriceSnapshot.create({
      data: {
        creatorId: CREATOR_IDS[1],
        currentPrice: 50n,
      },
    });
    await prisma.creatorPriceSnapshot.create({
      data: {
        creatorId: CREATOR_IDS[2],
        currentPrice: 50n,
      },
    });

    // Create key ownership records
    // Creator 1: balance = 3 -> total value = 300
    // Creator 2: balance = 3 -> total value = 150
    // Creator 3: balance = 1 -> total value = 50
    // To ensure the test does not pass by accident due to creation/insert order,
    // we insert Creator 2, then Creator 3, then Creator 1.
    await prisma.keyOwnership.create({
      data: {
        ownerAddress: WALLET_ADDRESS,
        creatorId: CREATOR_IDS[1],
        balance: 3.0,
      },
    });
    await prisma.keyOwnership.create({
      data: {
        ownerAddress: WALLET_ADDRESS,
        creatorId: CREATOR_IDS[2],
        balance: 1.0,
      },
    });
    await prisma.keyOwnership.create({
      data: {
        ownerAddress: WALLET_ADDRESS,
        creatorId: CREATOR_IDS[0],
        balance: 3.0,
      },
    });
  });

  afterAll(async () => {
    // Clean up seeded database tables
    await prisma.keyOwnership.deleteMany({});
    await prisma.creatorPriceSnapshot.deleteMany({});
    await prisma.creatorProfile.deleteMany({});
    await prisma.user.deleteMany({});
  });

  it('should return holdings ordered by total value descending by default', async () => {
    const res = await supertest(app).get(`/api/v1/wallets/${WALLET_ADDRESS}/holdings`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const { items, total } = res.body.data;
    expect(items).toHaveLength(3);
    expect(total).toBe(3);

    // Verify ordering by total holding value (balance * price) descending:
    // 1. Creator 1: total_value = 300
    // 2. Creator 2: total_value = 150
    // 3. Creator 3: total_value = 50
    expect(items[0].creator_id).toBe(CREATOR_IDS[0]);
    expect(items[0].total_value).toBe('300');

    expect(items[1].creator_id).toBe(CREATOR_IDS[1]);
    expect(items[1].total_value).toBe('150');

    expect(items[2].creator_id).toBe(CREATOR_IDS[2]);
    expect(items[2].total_value).toBe('50');

    // Confirm that the first has the highest and the last has the lowest
    const totalValues = items.map((item: any) => Number(item.total_value));
    expect(totalValues[0]).toBeGreaterThan(totalValues[1]);
    expect(totalValues[1]).toBeGreaterThan(totalValues[2]);
  });
});
