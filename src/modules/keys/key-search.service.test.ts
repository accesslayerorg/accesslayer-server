// src/modules/keys/key-search.service.test.ts
jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      $queryRaw: jest.fn(),
   },
}));

import { prisma } from '../../utils/prisma.utils';
import {
   KeySearchQueryTooShortError,
   searchKeys,
} from './key-search.service';

describe('key-search.service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('rejects queries shorter than 2 characters', async () => {
      await expect(searchKeys('a')).rejects.toBeInstanceOf(
         KeySearchQueryTooShortError
      );
      await expect(searchKeys(' ')).rejects.toBeInstanceOf(
         KeySearchQueryTooShortError
      );
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
   });

   it('returns mapped search results capped by the SQL limit', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([
         {
            keyId: 'k1',
            creatorName: 'Alice',
            avatarUrl: null,
            currentPrice: 1000n,
            holderCount: 3n,
            deprecatedAt: null,
            rank: 0.9,
         },
      ]);

      const results = await searchKeys('ali');
      expect(results).toEqual([
         {
            keyId: 'k1',
            creatorName: 'Alice',
            avatarUrl: null,
            currentPrice: '1000',
            holderCount: 3,
            deprecated: false,
         },
      ]);
   });

   it('flags a deprecated key in search results', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([
         {
            keyId: 'k2',
            creatorName: 'Bob',
            avatarUrl: null,
            currentPrice: null,
            holderCount: 0n,
            deprecatedAt: new Date('2026-01-01T00:00:00.000Z'),
            rank: 0.5,
         },
      ]);

      const results = await searchKeys('bob');
      expect(results[0].deprecated).toBe(true);
   });
});
