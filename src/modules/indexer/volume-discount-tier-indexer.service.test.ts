// src/modules/indexer/volume-discount-tier-indexer.service.test.ts
import {
   processVolumeDiscountTierEvents,
   VolumeDiscountTierChangedEvent,
} from './volume-discount-tier-indexer.service';
import { prisma } from '../../utils/prisma.utils';
import * as traderDiscountService from '../traders/trader-discount.service';
import { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

jest.mock('../traders/trader-discount.service', () => {
   const actual = jest.requireActual('../traders/trader-discount.service');
   return {
      ...actual,
      invalidateVolumeDiscountTiersCache: jest.fn().mockResolvedValue(undefined),
   };
});

describe('VolumeDiscountTierIndexerService', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('processes VolumeDiscountTierChanged events with a tiers array, upserts to DB, and invalidates cache', async () => {
      const mockUpsert = jest.fn().mockResolvedValue({});
      (prisma as any).volumeDiscountTier = {
         upsert: mockUpsert,
      };

      const event: VolumeDiscountTierChangedEvent = {
         eventType: 'VolumeDiscountTierChanged',
         txHash: 'txhash_vol_001',
         eventIndex: 0,
         ledger: 5000,
         tiers: [
            {
               tier: 0,
               name: 'Base Tier',
               volumeThreshold: '0',
               discountBps: 0,
            },
            {
               tier: 1,
               name: 'Tier 1',
               volumeThreshold: '1000000000000',
               discountBps: 100,
            },
            {
               tier: 2,
               name: 'Tier 2',
               volumeThreshold: '5000000000000',
               discountBps: 200,
            },
         ],
      };

      await processVolumeDiscountTierEvents([event]);

      expect(mockUpsert).toHaveBeenCalledTimes(3);
      expect(mockUpsert).toHaveBeenCalledWith({
         where: { tier: 0 },
         create: {
            tier: 0,
            name: 'Base Tier',
            volumeThreshold: '0',
            discountBps: 0,
         },
         update: {
            name: 'Base Tier',
            volumeThreshold: '0',
            discountBps: 0,
         },
      });
      expect(mockUpsert).toHaveBeenCalledWith({
         where: { tier: 1 },
         create: {
            tier: 1,
            name: 'Tier 1',
            volumeThreshold: '1000000000000',
            discountBps: 100,
         },
         update: {
            name: 'Tier 1',
            volumeThreshold: '1000000000000',
            discountBps: 100,
         },
      });

      expect(
         traderDiscountService.invalidateVolumeDiscountTiersCache
      ).toHaveBeenCalledTimes(1);
   });

   it('processes single-tier VolumeDiscountTierChanged events directly on the event payload', async () => {
      const mockUpsert = jest.fn().mockResolvedValue({});
      (prisma as any).volumeDiscountTier = {
         upsert: mockUpsert,
      };

      const event: VolumeDiscountTierChangedEvent = {
         eventType: 'VolumeDiscountTierChanged',
         txHash: 'txhash_vol_002',
         eventIndex: 0,
         ledger: 5001,
         tier: 3,
         name: 'VIP Tier',
         volumeThreshold: '10000000000000',
         discountBps: 300,
      };

      await processVolumeDiscountTierEvents([event]);

      expect(mockUpsert).toHaveBeenCalledTimes(1);
      expect(mockUpsert).toHaveBeenCalledWith({
         where: { tier: 3 },
         create: {
            tier: 3,
            name: 'VIP Tier',
            volumeThreshold: '10000000000000',
            discountBps: 300,
         },
         update: {
            name: 'VIP Tier',
            volumeThreshold: '10000000000000',
            discountBps: 300,
         },
      });
      expect(
         traderDiscountService.invalidateVolumeDiscountTiersCache
      ).toHaveBeenCalledTimes(1);
   });

   it('derives discountBps from feeBps when discountBps is omitted', async () => {
      const mockUpsert = jest.fn().mockResolvedValue({});
      (prisma as any).volumeDiscountTier = {
         upsert: mockUpsert,
      };

      const event: VolumeDiscountTierChangedEvent = {
         eventType: 'VOLUME_DISCOUNT_TIER_CHANGED',
         txHash: 'txhash_vol_003',
         eventIndex: 0,
         ledger: 5002,
         tier: 1,
         volumeThreshold: '1000000000000',
         feeBps: 400, // 500 base - 400 = 100 bps discount
      };

      await processVolumeDiscountTierEvents([event]);

      expect(mockUpsert).toHaveBeenCalledWith({
         where: { tier: 1 },
         create: {
            tier: 1,
            name: 'TIER_1',
            volumeThreshold: '1000000000000',
            discountBps: 100,
         },
         update: {
            name: 'TIER_1',
            volumeThreshold: '1000000000000',
            discountBps: 100,
         },
      });
   });

   it('deduplicates events with identical txHash and eventIndex', async () => {
      const mockUpsert = jest.fn().mockResolvedValue({});
      (prisma as any).volumeDiscountTier = {
         upsert: mockUpsert,
      };

      const event: VolumeDiscountTierChangedEvent = {
         eventType: 'VolumeDiscountTierChanged',
         txHash: 'txhash_duplicate',
         eventIndex: 0,
         ledger: 5003,
         tier: 1,
         volumeThreshold: '1000000000000',
         discountBps: 100,
      };

      // Pass the identical event twice in the same batch
      await processVolumeDiscountTierEvents([event, event]);

      // Deduplication guard ensures upsert only runs once
      expect(mockUpsert).toHaveBeenCalledTimes(1);
   });

   it('skips unrelated event types without mutating DB or cache', async () => {
      const mockUpsert = jest.fn();
      (prisma as any).volumeDiscountTier = {
         upsert: mockUpsert,
      };

      const event: IndexerChainEvent = {
         eventType: 'UNRELATED_EVENT',
         txHash: 'txhash_unrelated',
         eventIndex: 0,
         ledger: 5004,
      };

      await processVolumeDiscountTierEvents([event]);

      expect(mockUpsert).not.toHaveBeenCalled();
      expect(
         traderDiscountService.invalidateVolumeDiscountTiersCache
      ).not.toHaveBeenCalled();
   });

   it('skips events with missing or malformed tier items', async () => {
      const mockUpsert = jest.fn();
      (prisma as any).volumeDiscountTier = {
         upsert: mockUpsert,
      };

      const event: any = {
         eventType: 'VolumeDiscountTierChanged',
         txHash: 'txhash_bad',
         eventIndex: 0,
         ledger: 5005,
         tier: 'not-a-number',
         volumeThreshold: 'invalid',
         discountBps: -50,
      };

      await processVolumeDiscountTierEvents([event]);

      expect(mockUpsert).not.toHaveBeenCalled();
      expect(
         traderDiscountService.invalidateVolumeDiscountTiersCache
      ).not.toHaveBeenCalled();
   });
});
