import { seedLoadTestData } from '../seed';
import { prisma } from '../../src/utils/prisma.utils';

describe('loadtest/seed.ts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('seeds data when counts are below target and performs batched insertions', async () => {
    (prisma.creatorProfile.count as jest.Mock)
      .mockResolvedValueOnce(0) // initial count check
      .mockResolvedValueOnce(10000); // final count check

    (prisma.trade.count as jest.Mock)
      .mockResolvedValueOnce(0) // initial count check
      .mockResolvedValueOnce(100000); // final count check

    (prisma.user.upsert as jest.Mock).mockResolvedValue({
      id: 'seed-loadtest-user-id',
    });
    (prisma.stellarWallet.upsert as jest.Mock).mockResolvedValue({
      address: 'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR',
    });
    (prisma.creatorProfile.createMany as jest.Mock).mockResolvedValue({
      count: 1000,
    });
    (prisma.keyOwnership.createMany as jest.Mock).mockResolvedValue({
      count: 100,
    });
    (prisma.trade.createMany as jest.Mock).mockResolvedValue({ count: 5000 });

    await seedLoadTestData(prisma);

    expect(prisma.user.upsert).toHaveBeenCalled();
    expect(prisma.stellarWallet.upsert).toHaveBeenCalled();
    expect(prisma.creatorProfile.createMany).toHaveBeenCalled();
    expect(prisma.trade.createMany).toHaveBeenCalled();
  });

  it('is idempotent when run a second time (skips insertion when targets already reached)', async () => {
    (prisma.creatorProfile.count as jest.Mock).mockResolvedValueOnce(10000);
    (prisma.trade.count as jest.Mock).mockResolvedValueOnce(100000);

    await seedLoadTestData(prisma);

    // Should skip user upsert, creator createMany, trade createMany
    expect(prisma.creatorProfile.createMany).not.toHaveBeenCalled();
    expect(prisma.trade.createMany).not.toHaveBeenCalled();
  });
});
