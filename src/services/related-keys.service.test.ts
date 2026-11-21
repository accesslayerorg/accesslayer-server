jest.mock('../utils/prisma.utils', () => ({
   prisma: {
      $queryRaw: jest.fn(),
      $queryRawUnsafe: jest.fn(),
   },
}));

jest.mock('../utils/redis.utils', () => ({
   getRedis: jest.fn(),
}));

import { prisma } from '../utils/prisma.utils';
import { getRedis } from '../utils/redis.utils';
import {
   RELATED_KEYS_CACHE_TTL_SECONDS,
   RelatedKeysService,
} from './related-keys.service';

const queryRawMock = prisma.$queryRaw as unknown as jest.Mock;
const getRedisMock = getRedis as jest.Mock;

function mockRedis(raw: string | null = null) {
   const setex = jest.fn().mockResolvedValue('OK');
   getRedisMock.mockReturnValue({
      status: 'ready',
      get: jest.fn().mockResolvedValue(raw),
      setex,
   });
   return setex;
}

describe('RelatedKeysService.find', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockRedis(null);
   });

   it('orders results by weighted holder overlap score descending', async () => {
      queryRawMock.mockResolvedValue([
         { keyId: 'low', score: '2' },
         { keyId: 'high', score: 9 },
         { keyId: 'middle', score: 5n },
      ]);

      const results = await RelatedKeysService.find('source', 8);

      expect(results).toEqual([
         { keyId: 'high', score: 9 },
         { keyId: 'middle', score: 5 },
         { keyId: 'low', score: 2 },
      ]);
   });

   it('uses a holdings join and weights overlap with the smaller balance', async () => {
      queryRawMock.mockResolvedValue([]);

      await RelatedKeysService.find('source', 8);

      const sql = (queryRawMock.mock.calls[0][0] as string[]).join('');
      expect(sql).toContain('WITH holdings AS');
      expect(sql).toContain('JOIN holdings');
      expect(sql).toContain(
         'LEAST(source.balance::numeric, holdings.balance::numeric)'
      );
      expect(queryRawMock.mock.calls[0][3]).toBe(8);
   });

   it('excludes source, frozen, retired and deprecated keys', async () => {
      queryRawMock.mockResolvedValue([
         { keyId: 'source', score: 100 },
         { keyId: 'frozen', score: 90, isFrozen: true },
         { keyId: 'also-frozen', score: 80, frozen: true },
         { keyId: 'retired', score: 70, isRetired: true },
         { keyId: 'also-retired', score: 60, retired: true },
         { keyId: 'deprecated', score: 50, deprecatedAt: '2026-01-01' },
         { keyId: 'status-retired', score: 40, status: 'RETIRED' },
         { keyId: 'active', score: 30 },
      ]);

      const results = await RelatedKeysService.find('source', 8);

      expect(results).toEqual([{ keyId: 'active', score: 30 }]);
   });

   it('returns an empty list when the source key has no holders', async () => {
      queryRawMock.mockResolvedValue([]);

      await expect(RelatedKeysService.find('empty', 8)).resolves.toEqual([]);
   });

   it('caps the requested limit at 20', async () => {
      queryRawMock.mockResolvedValue([]);

      await RelatedKeysService.find('source', 100);

      expect(queryRawMock.mock.calls[0][3]).toBe(20);
   });

   it('caches results for 15 minutes and serves them on the next request', async () => {
      queryRawMock.mockResolvedValue([{ keyId: 'cached', score: 4 }]);
      const setex = mockRedis(null);

      const first = await RelatedKeysService.find('source', 8);
      expect(first).toEqual([{ keyId: 'cached', score: 4 }]);
      expect(setex).toHaveBeenCalledWith(
         'related:source',
         RELATED_KEYS_CACHE_TTL_SECONDS,
         JSON.stringify([{ keyId: 'cached', score: 4 }])
      );

      mockRedis(JSON.stringify([{ keyId: 'cached', score: 4 }]));
      const second = await RelatedKeysService.find('source', 8);

      expect(second).toEqual([{ keyId: 'cached', score: 4 }]);
      expect(queryRawMock).toHaveBeenCalledTimes(1);
   });
});
