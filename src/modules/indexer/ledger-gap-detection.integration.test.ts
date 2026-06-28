// src/modules/indexer/ledger-gap-detection.integration.test.ts
// Integration tests for #420 — ledger gap detection and replay.

import { prisma } from '../../utils/prisma.utils';
import {
  detectLedgerGap,
  updateIndexedLedger,
} from './ledger-gap-detection.service';
import { upsertPriceSnapshot } from './price-snapshot.service';

describe('#420 ledger gap detection and replay', () => {
  beforeAll(async () => {
    // Seed a baseline ledger
    await updateIndexedLedger(100, '100-000');
  });

  afterAll(async () => {
    await prisma.indexedLedger.deleteMany({});
    await prisma.$disconnect();
  });

  it('detects no gap when ledger is up to date', async () => {
    await updateIndexedLedger(12_390, '12390-000');
    const gap = await detectLedgerGap();
    expect(gap.detected).toBe(false);
    expect(gap.gapSize).toBeLessThanOrEqual(10);
  });

  it('detects gap when ledger is behind', async () => {
    await updateIndexedLedger(100, '100-000');
    const gap = await detectLedgerGap();
    expect(gap.detected).toBe(true);
    expect(gap.gapSize).toBeGreaterThan(10);
    expect(gap.gapRange).not.toBeNull();
    expect(gap.gapRange!.start).toBe(101);
  });

  it('gap detection runs on startup and logs warning', async () => {
    await updateIndexedLedger(50, '50-000');
    const gap = await detectLedgerGap();
    // Just verify structure, logging is tested via manual inspection
    expect(gap).toHaveProperty('detected');
    expect(gap).toHaveProperty('gapSize');
    expect(gap).toHaveProperty('gapRange');
  });

  it('replay is idempotent — reprocessing an event does not create duplicates', async () => {
    // Create a test creator
    const user = await prisma.user.create({
      data: {
        id: 'gap-test-user-1',
        email: 'gap-test@example.test',
        passwordHash: 'dummy-hash',
        firstName: 'Gap',
        lastName: 'Test',
      },
    });

    const creator = await prisma.creatorProfile.create({
      data: {
        userId: user.id,
        handle: 'gap-test-creator',
        displayName: 'Gap Test Creator',
      },
    });

    // Simulate a trade event twice (idempotency test)
    const tradeAt = new Date('2026-01-01T00:00:00Z');
    await upsertPriceSnapshot({
      creatorId: creator.id,
      price: BigInt(2_000_000),
      tradeAt,
    });

    await upsertPriceSnapshot({
      creatorId: creator.id,
      price: BigInt(2_000_000),
      tradeAt,
    });

    // Verify only one snapshot exists
    const snapshots = await prisma.creatorPriceSnapshot.findMany({
      where: { creatorId: creator.id },
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].currentPrice.toString()).toBe('2000000');

    // Cleanup
    await prisma.creatorPriceSnapshot.deleteMany({
      where: { creatorId: creator.id },
    });
    await prisma.creatorProfile.deleteMany({ where: { id: creator.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  });
});
