import { updateOwnership } from './ownership.service';
import { logger } from '../../utils/logger.utils';
import { prisma } from '../../utils/prisma.utils';

jest.mock('../../utils/prisma.utils', () => ({
  prisma: {
    keyOwnership: {
      findFirst: jest.fn(),
      upsert: jest.fn(),
    },
  },
}));

jest.mock('../../utils/logger.utils', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  HTTP_STATUS: {},
}));

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

function mockOwnership(balance: number) {
  return {
    id: 'own-1',
    ownerAddress: 'GTEST1234GTEST1234GTEST1234GTEST1234GTEST1234GTEST12345',
    creatorId: 'creator-1',
    balance: BigInt(balance),
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-02'),
  };
}

describe('updateOwnership — structured debug log', () => {
  const ownerAddress = 'GTEST1234GTEST1234GTEST1234GTEST1234GTEST1234GTEST12345';
  const creatorId = 'creator-1';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('emits debug log with all six required fields after successful update', async () => {
    (mockPrisma.keyOwnership.findFirst as jest.Mock).mockResolvedValue(mockOwnership(10));
    (mockPrisma.keyOwnership.upsert as jest.Mock).mockResolvedValue(mockOwnership(15));

    await updateOwnership(ownerAddress, creatorId, 5, {
      event_type: 'buy',
      ledger_sequence: 42,
    });

    expect(logger.debug).toHaveBeenCalledTimes(1);
    const [logFields, _msg] = (logger.debug as jest.Mock).mock.calls[0];

    expect(logFields).toMatchObject({
      creator_id: creatorId,
      previous_balance: 10,
      new_balance: 15,
      event_type: 'buy',
      ledger_sequence: 42,
    });
    expect(typeof logFields.wallet_address).toBe('string');
    expect(logFields.wallet_address).not.toBe(ownerAddress); // masked
    expect(logFields.wallet_address).toContain('GTES');  // first 4
    expect(logFields.wallet_address).toContain('2345');  // last 4
  });

  it('masks wallet address to first 4 and last 4 characters', async () => {
    (mockPrisma.keyOwnership.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.keyOwnership.upsert as jest.Mock).mockResolvedValue(mockOwnership(5));

    await updateOwnership(ownerAddress, creatorId, 5);

    const [logFields] = (logger.debug as jest.Mock).mock.calls[0];
    // masked address should not be the full address
    expect(logFields.wallet_address.length).toBeLessThan(ownerAddress.length);
    expect(logFields.wallet_address.startsWith(ownerAddress.slice(0, 4))).toBe(true);
    expect(logFields.wallet_address.endsWith(ownerAddress.slice(-4))).toBe(true);
  });

  it('sets previous_balance to 0 when record is new (create path)', async () => {
    (mockPrisma.keyOwnership.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.keyOwnership.upsert as jest.Mock).mockResolvedValue(mockOwnership(10));

    await updateOwnership(ownerAddress, creatorId, 10, { event_type: 'buy' });

    const [logFields] = (logger.debug as jest.Mock).mock.calls[0];
    expect(logFields.previous_balance).toBe(0);
    expect(logFields.new_balance).toBe(10);
  });

  it('correctly logs sell event type', async () => {
    (mockPrisma.keyOwnership.findFirst as jest.Mock).mockResolvedValue(mockOwnership(20));
    (mockPrisma.keyOwnership.upsert as jest.Mock).mockResolvedValue(mockOwnership(15));

    await updateOwnership(ownerAddress, creatorId, -5, { event_type: 'sell', ledger_sequence: 100 });

    const [logFields] = (logger.debug as jest.Mock).mock.calls[0];
    expect(logFields.event_type).toBe('sell');
    expect(logFields.ledger_sequence).toBe(100);
  });

  it('does not emit log when upsert throws', async () => {
    (mockPrisma.keyOwnership.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.keyOwnership.upsert as jest.Mock).mockRejectedValue(new Error('DB error'));

    await expect(updateOwnership(ownerAddress, creatorId, 5)).rejects.toThrow('DB error');
    expect(logger.debug).not.toHaveBeenCalled();
  });
});
