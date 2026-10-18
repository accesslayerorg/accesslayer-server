jest.mock('../../utils/prisma.utils', () => ({
  prisma: {
    keyFreeze: { findUnique: jest.fn(), upsert: jest.fn() },
    freezeEvent: { create: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.mock('../../utils/logger.utils', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../utils/audit.utils', () => ({ emitAuditEvent: jest.fn() }));

jest.mock('../../utils/freeze-cache.utils', () => ({
  invalidateFreezeCache: jest.fn(),
  getCachedFreezeStatus: jest.fn().mockReturnValue(null),
  setCachedFreezeStatus: jest.fn(),
}));

import { prisma } from '../../utils/prisma.utils';
import { invalidateFreezeCache } from '../../utils/freeze-cache.utils';
import { getFreezeHistory, getFreezeStatus, indexFreezeEvent } from './freeze.service';

const mockPrisma = prisma as unknown as {
  keyFreeze: { findUnique: jest.Mock; upsert: jest.Mock };
  freezeEvent: { create: jest.Mock; findMany: jest.Mock };
  $transaction: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback({ keyFreeze: mockPrisma.keyFreeze, freezeEvent: mockPrisma.freezeEvent })
  );
});

describe('freeze read model', () => {
  it('reports never-frozen keys as unfrozen with null metadata', async () => {
    mockPrisma.keyFreeze.findUnique.mockResolvedValue(null);
    await expect(getFreezeStatus('key-1')).resolves.toMatchObject({
      keyId: 'key-1', isFrozen: false, reason: null, expiryTimestamp: null,
    });
  });

  it('treats an expired freeze as currently unfrozen', async () => {
    mockPrisma.keyFreeze.findUnique.mockResolvedValue({
      keyId: 'key-1', isFrozen: true, reason: 'temporary',
      expiryTimestamp: new Date(Date.now() - 1000), frozenAt: null, frozenBy: null, proposalId: null,
    });
    await expect(getFreezeStatus('key-1')).resolves.toMatchObject({ isFrozen: false });
  });

  it('atomically writes a freeze event and current state, then invalidates that key cache', async () => {
    await indexFreezeEvent({
      keyId: 'key-1', eventType: 'FREEZE', ledger: 42, txHash: 'tx-1', eventIndex: 3,
      payload: { reason: 'policy', expiryTimestamp: '2026-10-20T10:00:00.000Z' },
    });
    expect(mockPrisma.freezeEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ keyId: 'key-1', ledger: BigInt(42), eventIndex: 3 }),
    });
    expect(mockPrisma.keyFreeze.upsert).toHaveBeenCalledWith({
      where: { keyId: 'key-1' },
      create: expect.objectContaining({ isFrozen: true, reason: 'policy', expiryTimestamp: new Date('2026-10-20T10:00:00.000Z') }),
      update: expect.objectContaining({ isFrozen: true, reason: 'policy' }),
    });
    expect(invalidateFreezeCache).toHaveBeenCalledWith('key-1');
  });

  it('returns freeze history in descending ledger and event-index order', async () => {
    mockPrisma.freezeEvent.findMany.mockResolvedValue([]);
    await getFreezeHistory('key-1');
    expect(mockPrisma.freezeEvent.findMany).toHaveBeenCalledWith({
      where: { keyId: 'key-1', eventType: { in: ['FREEZE', 'UNFREEZE'] } },
      orderBy: [{ ledger: 'desc' }, { eventIndex: 'desc' }],
    });
  });
});
