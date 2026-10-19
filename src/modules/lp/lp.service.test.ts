// src/modules/lp/lp.service.test.ts
import { prisma } from '../../utils/prisma.utils';
import * as lpRewardsContract from './lp-rewards.contract';
import {
   getLpPositionsWithLiveRewards,
   getLpPositionDetailWithLiveRewards,
   LpPositionNotFoundError,
} from './lp.service';
import {
   LpContractNotConfiguredError,
   LpRewardsFetchError,
} from './lp-rewards.contract';

describe('lp.service', () => {
   const wallet = 'GLPWALLET0000000000000000000000000000000000000000000';

   afterEach(() => {
      jest.restoreAllMocks();
   });

   describe('getLpPositionsWithLiveRewards', () => {
      it('1. list queries only status active', async () => {
         const findManySpy = jest
            .spyOn(prisma.lpPosition, 'findMany')
            .mockResolvedValueOnce([]);

         await getLpPositionsWithLiveRewards(wallet);

         expect(findManySpy).toHaveBeenCalledWith({
            where: { wallet, status: 'active' },
            orderBy: { createdAt: 'desc' },
         });
      });

      it('2. live value replaces stored value and rewardsSource is live', async () => {
         jest.spyOn(prisma.lpPosition, 'findMany').mockResolvedValueOnce([
            {
               lpId: 'lp-1',
               wallet,
               keyId: 'key-1',
               amount: '1000' as any,
               sharePercent: '10' as any,
               accruedRewards: '5.5' as any,
               status: 'active',
               createdAt: new Date('2026-09-01T00:00:00.000Z'),
               updatedAt: new Date('2026-09-01T00:00:00.000Z'),
            } as any,
         ]);
         jest
            .spyOn(lpRewardsContract, 'getLpRewardsLive')
            .mockResolvedValueOnce('42.0');

         const results = await getLpPositionsWithLiveRewards(wallet);

         expect(results).toHaveLength(1);
         expect(results[0].accruedRewards).toBe('42.0');
         expect(results[0].rewardsSource).toBe('live');
         expect(results[0].amount).toBe('1000');
      });

      it('3. falls back to stored value with rewardsSource stored when getLpRewardsLive throws LpRewardsFetchError', async () => {
         jest.spyOn(prisma.lpPosition, 'findMany').mockResolvedValueOnce([
            {
               lpId: 'lp-1',
               wallet,
               keyId: 'key-1',
               amount: '1000' as any,
               sharePercent: '10' as any,
               accruedRewards: '5.5' as any,
               status: 'active',
               createdAt: new Date('2026-09-01T00:00:00.000Z'),
               updatedAt: new Date('2026-09-01T00:00:00.000Z'),
            } as any,
         ]);
         jest
            .spyOn(lpRewardsContract, 'getLpRewardsLive')
            .mockRejectedValueOnce(new LpRewardsFetchError('RPC failure'));

         const results = await getLpPositionsWithLiveRewards(wallet);

         expect(results).toHaveLength(1);
         expect(results[0].accruedRewards).toBe('5.5');
         expect(results[0].rewardsSource).toBe('stored');
      });

      it('4. falls back when it throws LpContractNotConfiguredError', async () => {
         jest.spyOn(prisma.lpPosition, 'findMany').mockResolvedValueOnce([
            {
               lpId: 'lp-1',
               wallet,
               keyId: 'key-1',
               amount: '1000' as any,
               sharePercent: '10' as any,
               accruedRewards: '5.5' as any,
               status: 'active',
               createdAt: new Date('2026-09-01T00:00:00.000Z'),
               updatedAt: new Date('2026-09-01T00:00:00.000Z'),
            } as any,
         ]);
         jest
            .spyOn(lpRewardsContract, 'getLpRewardsLive')
            .mockRejectedValueOnce(new LpContractNotConfiguredError());

         const results = await getLpPositionsWithLiveRewards(wallet);

         expect(results).toHaveLength(1);
         expect(results[0].accruedRewards).toBe('5.5');
         expect(results[0].rewardsSource).toBe('stored');
      });

      it('7. with 7 active positions, never more than 5 live calls run at once', async () => {
         const mockPositions = Array.from({ length: 7 }, (_, i) => ({
            lpId: `lp-${i + 1}`,
            wallet,
            keyId: `key-${i + 1}`,
            amount: '1000' as any,
            sharePercent: '10' as any,
            accruedRewards: '5.0' as any,
            status: 'active',
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
            updatedAt: new Date('2026-09-01T00:00:00.000Z'),
         }));
         jest
            .spyOn(prisma.lpPosition, 'findMany')
            .mockResolvedValueOnce(mockPositions as any);

         let currentConcurrentCalls = 0;
         let maxConcurrentCalls = 0;

         jest
            .spyOn(lpRewardsContract, 'getLpRewardsLive')
            .mockImplementation(async () => {
               currentConcurrentCalls++;
               maxConcurrentCalls = Math.max(
                  maxConcurrentCalls,
                  currentConcurrentCalls
               );
               await new Promise((resolve) => setTimeout(resolve, 20));
               currentConcurrentCalls--;
               return '10.0';
            });

         const results = await getLpPositionsWithLiveRewards(wallet);

         expect(results).toHaveLength(7);
         expect(maxConcurrentCalls).toBeLessThanOrEqual(5);
         expect(maxConcurrentCalls).toBe(5);
         expect(lpRewardsContract.getLpRewardsLive).toHaveBeenCalledTimes(7);
      });
   });

   describe('getLpPositionDetailWithLiveRewards', () => {
      it('5. a removed position detail makes NO call to getLpRewardsLive', async () => {
         jest.spyOn(prisma.lpPosition, 'findUnique').mockResolvedValueOnce({
            lpId: 'lp-removed',
            wallet,
            keyId: 'key-1',
            amount: '0' as any,
            sharePercent: '0' as any,
            accruedRewards: '12.0' as any,
            status: 'removed',
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
            updatedAt: new Date('2026-09-01T00:00:00.000Z'),
         } as any);

         const liveSpy = jest.spyOn(lpRewardsContract, 'getLpRewardsLive');

         const result = await getLpPositionDetailWithLiveRewards(
            'lp-removed',
            wallet
         );

         expect(liveSpy).not.toHaveBeenCalled();
         expect(result.status).toBe('removed');
         expect(result.accruedRewards).toBe('12.0');
         expect(result.rewardsSource).toBe('stored');
      });

      it('6. detail of a position owned by another wallet throws LpPositionNotFoundError', async () => {
         jest.spyOn(prisma.lpPosition, 'findUnique').mockResolvedValueOnce({
            lpId: 'lp-other',
            wallet: 'GOTHERWALLET',
            keyId: 'key-1',
            amount: '1000' as any,
            sharePercent: '10' as any,
            accruedRewards: '5.0' as any,
            status: 'active',
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
            updatedAt: new Date('2026-09-01T00:00:00.000Z'),
         } as any);

         await expect(
            getLpPositionDetailWithLiveRewards('lp-other', wallet)
         ).rejects.toThrow(LpPositionNotFoundError);
      });

      it('detail of non-existent position throws LpPositionNotFoundError', async () => {
         jest.spyOn(prisma.lpPosition, 'findUnique').mockResolvedValueOnce(null);

         await expect(
            getLpPositionDetailWithLiveRewards('lp-none', wallet)
         ).rejects.toThrow(LpPositionNotFoundError);
      });

      it('fetches live rewards for active position detail', async () => {
         jest.spyOn(prisma.lpPosition, 'findUnique').mockResolvedValueOnce({
            lpId: 'lp-active',
            wallet,
            keyId: 'key-1',
            amount: '1000' as any,
            sharePercent: '10' as any,
            accruedRewards: '5.0' as any,
            status: 'active',
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
            updatedAt: new Date('2026-09-01T00:00:00.000Z'),
         } as any);

         jest
            .spyOn(lpRewardsContract, 'getLpRewardsLive')
            .mockResolvedValueOnce('55.5');

         const result = await getLpPositionDetailWithLiveRewards(
            'lp-active',
            wallet
         );

         expect(result.accruedRewards).toBe('55.5');
         expect(result.rewardsSource).toBe('live');
      });
   });
});
