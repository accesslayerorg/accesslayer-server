jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      stake: {
         findMany: jest.fn(),
         findFirst: jest.fn(),
         findUnique: jest.fn(),
      },
      epochReward: {
         findMany: jest.fn(),
         findFirst: jest.fn(),
      },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import {
   getWalletActiveStakes,
   getStakeDetail,
   getKeyEpochHistory,
   StakeNotFoundError,
} from './staking-epoch.service';

const stakeFindMany = (prisma as any).stake.findMany as jest.Mock;
const stakeFindFirst = (prisma as any).stake.findFirst as jest.Mock;
const epochRewardFindMany = (prisma as any).epochReward.findMany as jest.Mock;
const epochRewardFindFirst = (prisma as any).epochReward.findFirst as jest.Mock;

describe('staking-epoch.service (#1086)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('getWalletActiveStakes', () => {
      it('returns active stakes with epochs remaining and accrued rewards', async () => {
         epochRewardFindFirst.mockResolvedValue({ epoch: 5 });
         stakeFindMany.mockResolvedValue([
            {
               stakeId: 'stake-1',
               wallet: 'GWALLET1',
               keyId: 'key-100',
               amount: '100.0000000',
               startEpoch: 2,
               lockEpochs: 4,
               status: 'active',
               totalClaimed: '5.0000000',
            },
         ]);
         epochRewardFindMany.mockResolvedValue([
            { epoch: 2, rewardPerToken: '0.05' },
            { epoch: 3, rewardPerToken: '0.05' },
         ]);

         const result = await getWalletActiveStakes('GWALLET1');
         expect(result).toHaveLength(1);
         expect(result[0]).toEqual({
            stake_id: 'stake-1',
            key_id: 'key-100',
            amount: '100.0000000',
            epochs_remaining: 1, // 2 + 4 - 5 = 1
            accrued_rewards: '5.0000000', // 100 * (0.05 + 0.05) - 5 = 5.0
            status: 'active',
         });
      });

      it('filters out unstaked positions', async () => {
         stakeFindMany.mockResolvedValue([]);
         const result = await getWalletActiveStakes('GWALLET2');
         expect(result).toEqual([]);
         expect(stakeFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
               where: expect.objectContaining({
                  wallet: 'GWALLET2',
                  status: 'active',
                  unstakedAt: null,
               }),
            })
         );
      });
   });

   describe('getStakeDetail', () => {
      it('returns stake detail with epoch breakdown', async () => {
         epochRewardFindFirst.mockResolvedValue({ epoch: 6 });
         stakeFindFirst.mockResolvedValue({
            stakeId: 'stake-1',
            wallet: 'GWALLET1',
            keyId: 'key-100',
            amount: '50.0000000',
            startEpoch: 1,
            lockEpochs: 6,
            status: 'active',
            totalClaimed: '0.0000000',
         });
         epochRewardFindMany.mockResolvedValue([
            {
               epoch: 1,
               keyId: 'key-100',
               totalDistributed: '500.0000000',
               rewardPerToken: '0.1000000',
               distributedAt: new Date('2026-10-18T00:00:00Z'),
               txHash: '0xabc',
            },
         ]);

         const detail = await getStakeDetail('GWALLET1', 'stake-1');
         expect(detail.stake_id).toBe('stake-1');
         expect(detail.epoch_breakdown).toHaveLength(1);
         expect(detail.epoch_breakdown[0].epoch).toBe(1);
         expect(detail.epoch_breakdown[0].total_distributed).toBe('500.0000000');
      });

      it('throws StakeNotFoundError if stake does not exist', async () => {
         stakeFindFirst.mockResolvedValue(null);
         await expect(getStakeDetail('GWALLET1', 'unknown')).rejects.toThrow(
            StakeNotFoundError
         );
      });
   });

   describe('getKeyEpochHistory', () => {
      it('returns epoch reward history for key', async () => {
         epochRewardFindMany.mockResolvedValue([
            {
               epoch: 2,
               keyId: 'key-100',
               totalDistributed: '1000.0000000',
               rewardPerToken: '0.2000000',
               distributedAt: new Date('2026-10-19T00:00:00Z'),
               txHash: '0xepoch2',
            },
         ]);

         const history = await getKeyEpochHistory('key-100');
         expect(history).toHaveLength(1);
         expect(history[0].epoch).toBe(2);
         expect(history[0].total_distributed).toBe('1000.0000000');
         expect(history[0].reward_per_token).toBe('0.2000000');
      });
   });
});
