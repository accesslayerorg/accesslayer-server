// Unit test: fetchCreatorList emits a structured debug log after every query (#550)
//
// Verifies that:
//   - logger.debug is called once after each creator list query
//   - the log object contains result_count, filters, sort, and query_duration_ms
//   - only active filter keys appear in the filters object
//   - cursor is absent from the log output
//   - query_duration_ms is a non-negative number
//
// Uses Jest mocks — no database required.

import { fetchCreatorList } from './creators.utils';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';

// ── Module mocks ───────────────────────────────────────────────────────────────

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findMany: jest.fn(),
         count: jest.fn(),
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

// Disable the cache so every call hits the mocked prisma
jest.mock('./creators.cache', () => ({
   getCachedCreatorList: jest.fn().mockReturnValue(null),
   setCachedCreatorList: jest.fn(),
}));

// ── Typed helpers ──────────────────────────────────────────────────────────────

const mockPrisma = prisma as unknown as {
   creatorProfile: {
      findMany: jest.Mock;
      count: jest.Mock;
   };
};

const mockLogger = logger as unknown as {
   debug: jest.Mock;
   warn: jest.Mock;
};

// ── Shared fixtures ────────────────────────────────────────────────────────────

const BASE_QUERY = {
   limit: 20,
   offset: 0,
   sort: 'createdAt' as const,
   order: 'desc' as const,
   include: [] as never[],
};

const CREATOR_ROW = {
   id: 'cid-1',
   handle: 'creator1',
   displayName: 'Creator One',
   isVerified: false,
   createdAt: new Date('2025-01-01T00:00:00Z'),
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('fetchCreatorList – structured debug log (#550)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockPrisma.creatorProfile.findMany.mockResolvedValue([]);
      mockPrisma.creatorProfile.count.mockResolvedValue(0);
   });

   // ── Always emits ─────────────────────────────────────────────────────────────

   it('calls logger.debug exactly once per query', async () => {
      await fetchCreatorList(BASE_QUERY as any);

      expect(mockLogger.debug).toHaveBeenCalledTimes(1);
   });

   it('calls logger.debug even when result set is non-empty', async () => {
      mockPrisma.creatorProfile.findMany.mockResolvedValue([CREATOR_ROW]);
      mockPrisma.creatorProfile.count.mockResolvedValue(1);

      await fetchCreatorList(BASE_QUERY as any);

      expect(mockLogger.debug).toHaveBeenCalledTimes(1);
   });

   // ── result_count ──────────────────────────────────────────────────────────────

   it('log object contains result_count equal to the number of returned creators', async () => {
      mockPrisma.creatorProfile.findMany.mockResolvedValue([CREATOR_ROW, CREATOR_ROW]);
      mockPrisma.creatorProfile.count.mockResolvedValue(2);

      await fetchCreatorList(BASE_QUERY as any);

      const [logObj] = mockLogger.debug.mock.calls[0];
      expect(logObj).toHaveProperty('result_count', 2);
   });

   it('log object contains result_count of 0 when the list is empty', async () => {
      await fetchCreatorList(BASE_QUERY as any);

      const [logObj] = mockLogger.debug.mock.calls[0];
      expect(logObj).toHaveProperty('result_count', 0);
   });

   // ── filters – only active keys ────────────────────────────────────────────────

   it('filters object is empty when no filter params were provided', async () => {
      await fetchCreatorList(BASE_QUERY as any);

      const [logObj] = mockLogger.debug.mock.calls[0];
      expect(logObj).toHaveProperty('filters');
      expect(logObj.filters).toEqual({});
   });

   it('filters object contains only the verified key when only verified is provided', async () => {
      await fetchCreatorList({ ...BASE_QUERY, verified: true } as any);

      const [logObj] = mockLogger.debug.mock.calls[0];
      expect(logObj.filters).toEqual({ verified: true });
      expect(logObj.filters).not.toHaveProperty('search');
      expect(logObj.filters).not.toHaveProperty('minPrice');
      expect(logObj.filters).not.toHaveProperty('maxPrice');
   });

   it('filters object contains only the search key when only search is provided', async () => {
      await fetchCreatorList({ ...BASE_QUERY, search: 'artist' } as any);

      const [logObj] = mockLogger.debug.mock.calls[0];
      expect(logObj.filters).toHaveProperty('search', 'artist');
      expect(logObj.filters).not.toHaveProperty('verified');
   });

   it('filters object contains multiple keys when multiple filters are active', async () => {
      await fetchCreatorList({
         ...BASE_QUERY,
         verified: false,
         search: 'music',
         minPrice: BigInt(100),
      } as any);

      const [logObj] = mockLogger.debug.mock.calls[0];
      expect(logObj.filters).toHaveProperty('verified', false);
      expect(logObj.filters).toHaveProperty('search', 'music');
      expect(logObj.filters).toHaveProperty('minPrice');
   });

   // ── cursor absent from log ────────────────────────────────────────────────────

   it('cursor value is absent from the log output even when cursor is provided', async () => {
      await fetchCreatorList({
         ...BASE_QUERY,
         cursor: 'some-opaque-cursor-value',
      } as any);

      const [logObj] = mockLogger.debug.mock.calls[0];
      const serialized = JSON.stringify(logObj);
      expect(serialized).not.toContain('cursor');
      expect(serialized).not.toContain('some-opaque-cursor-value');
   });

   // ── sort ──────────────────────────────────────────────────────────────────────

   it('log object contains the sort field from the query', async () => {
      await fetchCreatorList({ ...BASE_QUERY, sort: 'createdAt' } as any);

      const [logObj] = mockLogger.debug.mock.calls[0];
      expect(logObj).toHaveProperty('sort', 'createdAt');
   });

   // ── query_duration_ms ─────────────────────────────────────────────────────────

   it('log object contains query_duration_ms as a non-negative number', async () => {
      await fetchCreatorList(BASE_QUERY as any);

      const [logObj] = mockLogger.debug.mock.calls[0];
      expect(logObj).toHaveProperty('query_duration_ms');
      expect(typeof logObj.query_duration_ms).toBe('number');
      expect(logObj.query_duration_ms).toBeGreaterThanOrEqual(0);
   });

   // ── log message ───────────────────────────────────────────────────────────────

   it('log message is "Creator list query resolved"', async () => {
      await fetchCreatorList(BASE_QUERY as any);

      const [, message] = mockLogger.debug.mock.calls[0];
      expect(message).toBe('Creator list query resolved');
   });
});
