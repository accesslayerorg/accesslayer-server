import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import { getWalletVotingWeight, invalidateKeyVotingWeightCache } from './governance-voting-weight.service';

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(),
   cacheSetJson: jest.fn().mockResolvedValue(undefined),
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../whitelist/whitelist.service', () => ({
   resolveCreatorId: jest.fn().mockResolvedValue('key-1'),
}));

const delegations = prisma.voteDelegation.findMany as jest.Mock;
const holdings = prisma.keyOwnership.findMany as jest.Mock;

describe('current wallet voting weight', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      (cacheGetJson as jest.Mock).mockResolvedValue(null);
      delegations.mockResolvedValue([]);
      holdings.mockResolvedValue([]);
   });

   it('sums own and active delegated balances exactly, excluding self delegation', async () => {
      delegations.mockResolvedValue([
         { delegatorWallet: 'other-2' },
         { delegatorWallet: 'self' },
         { delegatorWallet: 'other-1' },
      ]);
      holdings.mockResolvedValue([
         { ownerAddress: 'self', balance: new Decimal('9007199254740993.25') },
         { ownerAddress: 'other-1', balance: new Decimal('1.5') },
         { ownerAddress: 'other-2', balance: new Decimal('0.25') },
      ]);
      const result = await getWalletVotingWeight('self', 'alias');
      expect(result).toEqual({
         own_weight: '9007199254740993.25',
         delegated_weight: '1.75',
         total: '9007199254740995',
         delegators: [
            { wallet: 'other-1', amount: '1.5' },
            { wallet: 'other-2', amount: '0.25' },
         ],
      });
      expect(delegations).toHaveBeenCalledWith(expect.objectContaining({
         where: { keyId: 'key-1', delegateeWallet: 'self', isActive: true, delegatorWallet: { not: 'self' } },
      }));
      expect(cacheSetJson).toHaveBeenCalledWith(expect.any(String), result, 60);
   });

   it('preserves sums across the full stored balance precision', async () => {
      delegations.mockResolvedValue([{ delegatorWallet: 'other' }]);
      holdings.mockResolvedValue([
         { ownerAddress: 'self', balance: new Decimal('123456789012345678901234567890.125') },
         { ownerAddress: 'other', balance: new Decimal('0.875') },
      ]);
      expect((await getWalletVotingWeight('self', 'key-1')).total).toBe('123456789012345678901234567891');
   });

   it('returns zero for a wallet with no holdings or delegations', async () => {
      expect(await getWalletVotingWeight('empty', 'key-1')).toEqual({
         own_weight: '0', delegated_weight: '0', total: '0', delegators: [],
      });
   });

   it('lists an active delegator who has no current holdings with amount zero', async () => {
      delegations.mockResolvedValue([{ delegatorWallet: 'empty' }]);
      expect((await getWalletVotingWeight('self', 'key-1')).delegators).toEqual([
         { wallet: 'empty', amount: '0' },
      ]);
   });

   it('serves cached weights without reading balances or delegations', async () => {
      const cached = { own_weight: '2', delegated_weight: '3', total: '5', delegators: [] };
      (cacheGetJson as jest.Mock).mockResolvedValue(cached);
      expect(await getWalletVotingWeight('self', 'key-1')).toEqual(cached);
      expect(holdings).not.toHaveBeenCalled();
      expect(delegations).not.toHaveBeenCalled();
   });

   it('invalidates every wallet for the changed key', async () => {
      await invalidateKeyVotingWeightCache('key-1');
      expect(cacheInvalidate).toHaveBeenCalledWith('governance:voting-weight:key-1:*');
   });
});
