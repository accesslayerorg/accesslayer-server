// src/modules/indexer/price-snapshot.integration.test.ts
// Integration test: price fields update after a simulated trade event.

import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';
import { upsertPriceSnapshot } from './price-snapshot.service';

const USER_ID = 'price-snap-test-user-1';
const HANDLE = 'price-snap-test-creator-1';

describe('#417 price snapshot — fields update after a simulated trade', () => {
  let creatorId: string;

  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: USER_ID },
      create: {
        id: USER_ID,
        email: 'price-snap-test@example.test',
        passwordHash: 'dummy-hash',
        firstName: 'Price',
        lastName: 'Snap',
      },
      update: {},
    });

    const creator = await prisma.creatorProfile.upsert({
      where: { userId: USER_ID },
      create: {
        userId: USER_ID,
        handle: HANDLE,
        displayName: 'Price Snap Creator',
      },
      update: {},
    });

    creatorId = creator.id;
  });

  afterAll(async () => {
    await prisma.creatorPriceSnapshot.deleteMany({ where: { creatorId } });
    await prisma.creatorProfile.deleteMany({ where: { handle: HANDLE } });
    await prisma.user.deleteMany({ where: { id: USER_ID } });
    await prisma.$disconnect();
  });

  it('creator list returns null price before any trade', async () => {
    const res = await supertest(app).get('/api/v1/creators');
    expect(res.status).toBe(200);
    const item = (res.body.data.items as any[]).find(
      (c: any) => c.id === creatorId
    );
    expect(item).toBeDefined();
    expect(item.currentPrice).toBeNull();
    expect(item.priceChange24h).toBeNull();
  });

  it('creator detail returns null price before any trade', async () => {
    const res = await supertest(app).get(
      `/api/v1/creators/${creatorId}/profile`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.currentPrice).toBeNull();
    expect(res.body.data.priceChange24h).toBeNull();
  });

  it('price fields update after a simulated trade event', async () => {
    await upsertPriceSnapshot({
      creatorId,
      price: BigInt(2_000_000),
      tradeAt: new Date(),
    });

    const listRes = await supertest(app).get('/api/v1/creators');
    expect(listRes.status).toBe(200);
    const item = (listRes.body.data.items as any[]).find(
      (c: any) => c.id === creatorId
    );
    expect(item).toBeDefined();
    expect(item.currentPrice).toBe('2000000');

    const detailRes = await supertest(app).get(
      `/api/v1/creators/${creatorId}/profile`
    );
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.data.currentPrice).toBe('2000000');
  });

  it('is idempotent — replaying the same event does not change the snapshot', async () => {
    const tradeAt = new Date('2026-01-01T00:00:00Z');

    await upsertPriceSnapshot({ creatorId, price: BigInt(5_000_000), tradeAt });
    await upsertPriceSnapshot({ creatorId, price: BigInt(5_000_000), tradeAt });

    const snap = await prisma.creatorPriceSnapshot.findUnique({
      where: { creatorId },
    });
    // Should still be 5_000_000 from the first call, not doubled or errored
    expect(snap?.currentPrice.toString()).toBe('5000000');
  });
});
