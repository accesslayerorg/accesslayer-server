import { prisma } from '../../utils/prisma.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import { invalidateKeyVotingWeightCache } from '../governance/governance-voting-weight.service';
import { onConcentrationBalanceChanged } from '../concentration/concentration.service';
import { onHolderBalanceChanged } from './key-holder-leaderboard.service';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findFirst: jest.fn() },
      keyOwnership: {
         findMany: jest.fn().mockResolvedValue([]),
         count: jest.fn().mockResolvedValue(0),
         aggregate: jest.fn().mockResolvedValue({ _sum: { balance: 0 } }),
      },
   },
}));
jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(),
   cacheSetJson: jest.fn().mockResolvedValue(undefined),
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../utils/logger.utils', () => ({
   logger: { warn: jest.fn() },
}));
jest.mock('../governance/governance-voting-weight.service', () => ({
   invalidateKeyVotingWeightCache: jest.fn(),
}));
jest.mock('../concentration/concentration.service', () => ({
   onConcentrationBalanceChanged: jest.fn(),
}));

const voting = invalidateKeyVotingWeightCache as jest.Mock;
const concentration = onConcentrationBalanceChanged as jest.Mock;

beforeEach(() => {
   jest.clearAllMocks();
   (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
      id: 'key-1', circulatingSupply: 0,
   });
   voting.mockReset().mockResolvedValue(undefined);
   concentration.mockReset().mockResolvedValue(undefined);
});

describe('balance changes invalidate every dependent projection', () => {
   it('invalidates voting weight and concentration once per distinct key', async () => {
      await onHolderBalanceChanged('key-1', 'key-1', '');
      expect(voting).toHaveBeenCalledTimes(1);
      expect(voting).toHaveBeenCalledWith('key-1');
      expect(concentration).toHaveBeenCalledTimes(1);
      expect(concentration).toHaveBeenCalledWith('key-1');
   });

   it('invalidates both projections even when the leaderboard refresh fails', async () => {
      (prisma.creatorProfile.findFirst as jest.Mock).mockRejectedValueOnce(new Error('database unavailable'));
      await expect(onHolderBalanceChanged('key-1')).resolves.toBeUndefined();
      expect(cacheInvalidate).toHaveBeenCalledWith('key:holder-leaderboard:key-1');
      expect(voting).toHaveBeenCalledWith('key-1');
      expect(concentration).toHaveBeenCalledWith('key-1');
   });

   it('refreshes concentration when voting cache invalidation fails', async () => {
      voting.mockRejectedValueOnce(new Error('voting cache unavailable'));
      await expect(onHolderBalanceChanged('key-1')).resolves.toBeUndefined();
      expect(concentration).toHaveBeenCalledWith('key-1');
   });

   it('continues invalidating subsequent keys when concentration refresh fails', async () => {
      concentration.mockRejectedValueOnce(new Error('concentration cache unavailable'));
      await expect(onHolderBalanceChanged('key-1', 'key-2')).resolves.toBeUndefined();
      expect(voting).toHaveBeenCalledWith('key-2');
      expect(concentration).toHaveBeenCalledWith('key-2');
   });
});
