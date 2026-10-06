// src/modules/indexer/staking-tier-indexer.service.test.ts
import {
   processStakingTierEvents,
   StakingTierConfigUpdateEvent,
} from './staking-tier-indexer.service';
import { prisma } from '../../utils/prisma.utils';
import * as stakingService from '../staking/staking.service';
import { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

jest.mock('../staking/staking.service', () => {
   const actual = jest.requireActual('../staking/staking.service');
   return {
      ...actual,
      invalidateStakingTiersCache: jest.fn().mockResolvedValue(undefined),
   };
});

describe('StakingTierIndexerService', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('processes TIER_CONFIG_UPDATED events, updates tiers in DB, and invalidates cache', async () => {
      const mockUpsert = jest.fn().mockResolvedValue({});
      (prisma as any).stakingMultiplierTier = {
         upsert: mockUpsert,
      };

      const event: StakingTierConfigUpdateEvent = {
         eventType: 'TIER_CONFIG_UPDATED',
         txHash: 'txhash001',
         eventIndex: 0,
         ledger: 1000,
         tiers: [
            {
               tier: 0,
               name: 'Flexible Staking',
               lockPeriodSeconds: 0,
               multiplier: 1.0,
            },
            {
               tier: 1,
               name: '1 Month Staking',
               lockPeriodSeconds: 2592000,
               multiplier: 1.35,
            },
            {
               tier: 2,
               name: '3 Month Staking',
               lockPeriodSeconds: 7776000,
               multiplier: 1.75,
            },
         ],
      };

      await processStakingTierEvents([event]);

      expect(mockUpsert).toHaveBeenCalledTimes(3);
      expect(mockUpsert).toHaveBeenCalledWith({
         where: { tier: 0 },
         create: {
            tier: 0,
            name: 'Flexible Staking',
            lockPeriodSeconds: 0,
            multiplier: 1.0,
         },
         update: {
            name: 'Flexible Staking',
            lockPeriodSeconds: 0,
            multiplier: 1.0,
         },
      });
      expect(mockUpsert).toHaveBeenCalledWith({
         where: { tier: 1 },
         create: {
            tier: 1,
            name: '1 Month Staking',
            lockPeriodSeconds: 2592000,
            multiplier: 1.35,
         },
         update: {
            name: '1 Month Staking',
            lockPeriodSeconds: 2592000,
            multiplier: 1.35,
         },
      });

      expect(stakingService.invalidateStakingTiersCache).toHaveBeenCalledTimes(
         1
      );
   });

   it('also processes STAKING_TIER_CONFIG_UPDATED alias event type', async () => {
      const mockUpsert = jest.fn().mockResolvedValue({});
      (prisma as any).stakingMultiplierTier = {
         upsert: mockUpsert,
      };

      const event: StakingTierConfigUpdateEvent = {
         eventType: 'STAKING_TIER_CONFIG_UPDATED',
         txHash: 'txhash002',
         eventIndex: 0,
         ledger: 1001,
         tiers: [
            {
               tier: 0,
               lockPeriodSeconds: 0,
               multiplier: 1.0,
            },
         ],
      };

      await processStakingTierEvents([event]);

      expect(mockUpsert).toHaveBeenCalledTimes(1);
      expect(stakingService.invalidateStakingTiersCache).toHaveBeenCalledTimes(
         1
      );
   });

   it('skips unrelated event types without mutating DB or invalidating cache', async () => {
      const mockUpsert = jest.fn();
      (prisma as any).stakingMultiplierTier = {
         upsert: mockUpsert,
      };

      const event: IndexerChainEvent = {
         eventType: 'SOME_OTHER_EVENT',
         txHash: 'txhash003',
         eventIndex: 0,
         ledger: 1002,
      };

      await processStakingTierEvents([event]);

      expect(mockUpsert).not.toHaveBeenCalled();
      expect(stakingService.invalidateStakingTiersCache).not.toHaveBeenCalled();
   });

   it('skips events with missing or empty tiers array', async () => {
      const mockUpsert = jest.fn();
      (prisma as any).stakingMultiplierTier = {
         upsert: mockUpsert,
      };

      const event: any = {
         eventType: 'TIER_CONFIG_UPDATED',
         txHash: 'txhash004',
         eventIndex: 0,
         ledger: 1003,
         tiers: [],
      };

      await processStakingTierEvents([event]);

      expect(mockUpsert).not.toHaveBeenCalled();
      expect(stakingService.invalidateStakingTiersCache).not.toHaveBeenCalled();
   });

   it('skips events with malformed tier objects', async () => {
      const mockUpsert = jest.fn();
      (prisma as any).stakingMultiplierTier = {
         upsert: mockUpsert,
      };

      const event: any = {
         eventType: 'TIER_CONFIG_UPDATED',
         txHash: 'txhash005',
         eventIndex: 0,
         ledger: 1004,
         tiers: [
            {
               tier: 'invalid-tier-not-a-number',
               lockPeriodSeconds: 100,
               multiplier: 1.5,
            },
         ],
      };

      await processStakingTierEvents([event]);

      expect(mockUpsert).not.toHaveBeenCalled();
      expect(stakingService.invalidateStakingTiersCache).not.toHaveBeenCalled();
   });
});
