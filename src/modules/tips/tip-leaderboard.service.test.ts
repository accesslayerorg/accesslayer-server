import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import { getTipLeaderboard } from './tip-leaderboard.service';
import { invalidateKeyTipsCache } from './tips.service';

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(),
   cacheSetJson: jest.fn().mockResolvedValue(undefined),
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../whitelist/whitelist.service', () => ({
   resolveCreatorId: jest.fn().mockResolvedValue('key-1'),
}));

const groupBy = prisma.keyTip.groupBy as jest.Mock;

describe('tip leaderboard', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      (cacheGetJson as jest.Mock).mockResolvedValue(null);
      groupBy.mockResolvedValue([]);
   });

   it('ranks totals, preserves decimal precision and hides anonymous identities', async () => {
      const wallet = 'G' + 'A'.repeat(55);
      groupBy.mockResolvedValue([
         { tipper: wallet, anonymous: true, _sum: { amount: new Decimal('9007199254740.0000001') }, _count: { _all: 2 } },
         { tipper: wallet, anonymous: false, _sum: { amount: new Decimal('3.25') }, _count: { _all: 3 } },
      ]);
      const result = await getTipLeaderboard('key-1', 20);
      expect(result).toEqual([
         { rank: 1, wallet: null, anonymous: true, total_tipped: '9007199254740.0000001', tip_count: 2 },
         { rank: 2, wallet: wallet.slice(0, 6) + '…' + wallet.slice(-4), anonymous: false, total_tipped: '3.2500000', tip_count: 3 },
      ]);
      expect(JSON.stringify(result)).not.toContain(wallet);
      expect(groupBy).toHaveBeenCalledWith(expect.objectContaining({
         by: ['tipper', 'anonymous'], where: { keyId: 'key-1' }, take: 20,
         orderBy: [{ _sum: { amount: 'desc' } }, { tipper: 'asc' }, { anonymous: 'asc' }],
      }));
      expect(cacheSetJson).toHaveBeenCalledWith('key:tips:key-1:leaderboard:20', result, 300);
   });

   it('returns an empty list when the key has no tips', async () => {
      expect(await getTipLeaderboard('key-1', 10)).toEqual([]);
   });

   it('serves cached results without aggregating tips', async () => {
      (cacheGetJson as jest.Mock).mockResolvedValue([]);
      expect(await getTipLeaderboard('key-1', 10)).toEqual([]);
      expect(groupBy).not.toHaveBeenCalled();
   });

   it('shares the indexer invalidation namespace with tip history', async () => {
      await invalidateKeyTipsCache('key-1');
      expect(cacheInvalidate).toHaveBeenCalledWith('key:tips:key-1:*');
   });
});
