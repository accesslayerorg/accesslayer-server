// Unit test: fetchCreatorHolders emits a debug log when holder count is zero (#443)
//
// Verifies that the zero-holder debug log is emitted correctly, includes the
// expected structured fields, and is NOT emitted when holders are present.
// Uses Jest mocks — no database required.

import { fetchCreatorHolders } from './creator-holders.service';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';

jest.mock('../../utils/prisma.utils', () => ({
  prisma: {
    keyOwnership: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
    creatorProfile: {
      findMany: jest.fn(),
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
}));

const mockPrisma = prisma as unknown as {
  keyOwnership: {
    findMany: jest.Mock;
    count: jest.Mock;
  };
};

const mockLogger = logger as unknown as {
  debug: jest.Mock;
};

const CREATOR_ID = 'creator-cuid-abc123';
const DEFAULT_QUERY = { limit: 20, offset: 0, sort: 'key_balance' as const };

const HOLDER_ROW = {
  ownerAddress: 'GWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  balance: BigInt(10),
  createdAt: new Date('2025-01-01T00:00:00Z'),
};

describe('fetchCreatorHolders – zero-holder debug log (#443)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Test 1 – logger.debug is called when holder count is 0
  it('calls logger.debug when the holders array is empty', async () => {
    mockPrisma.keyOwnership.findMany.mockResolvedValue([]);
    mockPrisma.keyOwnership.count.mockResolvedValue(0);

    await fetchCreatorHolders(CREATOR_ID, DEFAULT_QUERY);

    expect(mockLogger.debug).toHaveBeenCalledTimes(1);
  });

  // Test 2 – log object includes creator_id, holder_count: 0, query_duration_ms
  it('log object includes creator_id, holder_count 0, and query_duration_ms', async () => {
    mockPrisma.keyOwnership.findMany.mockResolvedValue([]);
    mockPrisma.keyOwnership.count.mockResolvedValue(0);

    await fetchCreatorHolders(CREATOR_ID, DEFAULT_QUERY);

    const [logObj, message] = mockLogger.debug.mock.calls[0];
    expect(logObj).toMatchObject({
      creator_id: CREATOR_ID,
      holder_count: 0,
    });
    expect(typeof logObj.query_duration_ms).toBe('number');
    expect(message).toBe('Creator holders query returned zero results');
  });

  // Test 3 – logger.debug is NOT called when holders are present
  it('does NOT call logger.debug when holders are returned', async () => {
    mockPrisma.keyOwnership.findMany.mockResolvedValue([HOLDER_ROW]);
    mockPrisma.keyOwnership.count.mockResolvedValue(1);

    await fetchCreatorHolders(CREATOR_ID, DEFAULT_QUERY);

    expect(mockLogger.debug).not.toHaveBeenCalled();
  });

  // Test 4 – query_duration_ms is a non-negative number
  it('query_duration_ms is a non-negative number', async () => {
    mockPrisma.keyOwnership.findMany.mockResolvedValue([]);
    mockPrisma.keyOwnership.count.mockResolvedValue(0);

    await fetchCreatorHolders(CREATOR_ID, DEFAULT_QUERY);

    const [logObj] = mockLogger.debug.mock.calls[0];
    expect(logObj.query_duration_ms).toBeGreaterThanOrEqual(0);
  });
});
