// src/modules/keys/key-swap-fee.service.test.ts
const cacheStore = new Map<string, unknown>();

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) =>
      cacheStore.has(key) ? cacheStore.get(key) : null
   ),
   cacheSetJson: jest.fn(async (key: string, value: unknown) => {
      cacheStore.set(key, value);
   }),
   cacheInvalidate: jest.fn(async (...keys: string[]) => {
      for (const k of keys) {
         cacheStore.delete(k);
      }
   }),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findFirst: jest.fn(),
      },
      keyFeeHistory: {
         findMany: jest.fn(),
      },
   },
}));

jest.mock('../../utils/trading-volume.utils', () => ({
   compute24hVolume: jest.fn(),
}));

jest.mock('../protocol/fee-tier.service', () => ({
   loadFeeTierConfig: jest.fn(),
}));

jest.mock('./key-swap-fee-contract', () => ({
   fetchCurrentFeeBpsFromContract: jest.fn(),
}));

import { prisma } from '../../utils/prisma.utils';
import { cacheSetJson } from '../../utils/redis.utils';
import { compute24hVolume } from '../../utils/trading-volume.utils';
import { loadFeeTierConfig } from '../protocol/fee-tier.service';
import { fetchCurrentFeeBpsFromContract } from './key-swap-fee-contract';
import {
   getSwapFeeTier,
   getKeyFeeHistory,
   invalidateKeyFeeCache,
   KeyNotFoundError,
   SWAP_FEE_CACHE_TTL_SECONDS,
   swapFeeCacheKey,
} from './key-swap-fee.service';

const mockPrisma = prisma as unknown as {
   creatorProfile: { findFirst: jest.Mock };
   keyFeeHistory: { findMany: jest.Mock };
};
const mockCacheSetJson = cacheSetJson as jest.Mock;
const mockCompute24hVolume = compute24hVolume as jest.Mock;
const mockLoadFeeTierConfig = loadFeeTierConfig as jest.Mock;
const mockFetchContractFee = fetchCurrentFeeBpsFromContract as jest.Mock;

describe('key-swap-fee.service', () => {
   const KEY_ID = 'key-uuid-1';
   const DEFAULT_TIERS = [
      { volumeThreshold: 0, feeBps: 500, label: 'TIER_1' },
      { volumeThreshold: 1_000_000_000, feeBps: 400, label: 'TIER_2' },
      { volumeThreshold: 5_000_000_000, feeBps: 300, label: 'TIER_3' },
   ];

   beforeEach(() => {
      cacheStore.clear();
      jest.clearAllMocks();

      mockPrisma.creatorProfile.findFirst.mockResolvedValue({
         id: KEY_ID,
         handle: 'alice',
      });

      mockCompute24hVolume.mockResolvedValue(2_000_000_000n);
      mockLoadFeeTierConfig.mockResolvedValue(DEFAULT_TIERS);
      mockFetchContractFee.mockResolvedValue(400);
   });

   describe('getSwapFeeTier', () => {
      it('returns correct bps, bracket, and volume values', async () => {
         const result = await getSwapFeeTier(KEY_ID);

         expect(result).toEqual({
            current_fee_bps: 400,
            volume_bracket: 'TIER_2',
            rolling_24h_volume: '2000000000',
         });
         expect(mockPrisma.creatorProfile.findFirst).toHaveBeenCalledWith({
            where: { OR: [{ id: KEY_ID }, { handle: KEY_ID }] },
            select: { id: true, handle: true },
         });
         expect(mockCompute24hVolume).toHaveBeenCalledWith(KEY_ID);
         expect(mockFetchContractFee).toHaveBeenCalledWith(KEY_ID);
         expect(mockCacheSetJson).toHaveBeenCalledWith(
            swapFeeCacheKey(KEY_ID),
            {
               current_fee_bps: 400,
               volume_bracket: 'TIER_2',
               rolling_24h_volume: '2000000000',
            },
            SWAP_FEE_CACHE_TTL_SECONDS
         );
      });

      it('falls back to volume tier fee when contract read returns null', async () => {
         mockFetchContractFee.mockResolvedValue(null);

         const result = await getSwapFeeTier(KEY_ID);

         expect(result).toEqual({
            current_fee_bps: 400,
            volume_bracket: 'TIER_2',
            rolling_24h_volume: '2000000000',
         });
      });

      it('uses 60s cache to reduce RPC calls under normal traffic', async () => {
         // First call (cache miss) -> calls contract
         const res1 = await getSwapFeeTier(KEY_ID);
         expect(res1.current_fee_bps).toBe(400);
         expect(mockFetchContractFee).toHaveBeenCalledTimes(1);

         // Second call within 60s (cache hit) -> does NOT call contract RPC
         const res2 = await getSwapFeeTier(KEY_ID);
         expect(res2).toEqual(res1);
         expect(mockFetchContractFee).toHaveBeenCalledTimes(1);
      });

      it('refetches from contract after cache invalidation', async () => {
         await getSwapFeeTier(KEY_ID);
         expect(mockFetchContractFee).toHaveBeenCalledTimes(1);

         // Invalidate cache
         await invalidateKeyFeeCache(KEY_ID);

         // Call again -> triggers contract read
         await getSwapFeeTier(KEY_ID);
         expect(mockFetchContractFee).toHaveBeenCalledTimes(2);
      });

      it('throws KeyNotFoundError for unknown key IDs', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue(null);

         await expect(getSwapFeeTier('unknown-key')).rejects.toThrow(
            KeyNotFoundError
         );
         expect(mockFetchContractFee).not.toHaveBeenCalled();
      });
   });

   describe('getKeyFeeHistory', () => {
      it('returns fee tier change records with timestamps', async () => {
         const mockDate = new Date('2026-10-17T12:00:00Z');
         mockPrisma.keyFeeHistory.findMany.mockResolvedValue([
            {
               id: 'h-1',
               keyId: KEY_ID,
               feeBps: 400,
               previousFeeBps: 500,
               volumeBracket: 'TIER_2',
               rolling24hVolume: '2000000000',
               ledger: 100,
               txHash: '0xabc',
               eventIndex: 0,
               timestamp: mockDate,
               createdAt: mockDate,
            },
         ]);

         const history = await getKeyFeeHistory(KEY_ID);

         expect(history).toHaveLength(1);
         expect(history[0]).toEqual({
            id: 'h-1',
            key_id: KEY_ID,
            keyId: KEY_ID,
            fee_bps: 400,
            feeBps: 400,
            current_fee_bps: 400,
            previous_fee_bps: 500,
            previousFeeBps: 500,
            volume_bracket: 'TIER_2',
            volumeBracket: 'TIER_2',
            rolling_24h_volume: '2000000000',
            rolling24hVolume: '2000000000',
            ledger: 100,
            tx_hash: '0xabc',
            txHash: '0xabc',
            event_index: 0,
            eventIndex: 0,
            timestamp: mockDate.toISOString(),
            created_at: mockDate.toISOString(),
         });
         expect(mockPrisma.keyFeeHistory.findMany).toHaveBeenCalledWith({
            where: { keyId: KEY_ID },
            orderBy: { timestamp: 'desc' },
            take: 50,
            skip: 0,
         });
      });

      it('throws KeyNotFoundError for unknown key IDs', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue(null);

         await expect(getKeyFeeHistory('unknown-key')).rejects.toThrow(
            KeyNotFoundError
         );
      });
   });
});
