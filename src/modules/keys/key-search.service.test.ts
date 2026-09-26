// src/modules/keys/key-search.service.test.ts
jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      $queryRaw: jest.fn(),
   },
}));

import { prisma } from '../../utils/prisma.utils';
import { KeySearchQueryTooShortError, searchKeys } from './key-search.service';

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
         },
      ]);
   });
});
