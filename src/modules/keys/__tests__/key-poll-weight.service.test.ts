// src/modules/keys/__tests__/key-poll-weight.service.test.ts
import { Decimal } from '@prisma/client/runtime/library';

const mockCache = new Map<string, string>();
const mockTtls = new Map<string, number>();

jest.mock('../../../utils/redis.utils', () => {
   const toRegex = (pattern: string) =>
      new RegExp(
         '^' +
            pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') +
            '$'
      );
   return {
      cacheGetJson: jest.fn(async (key: string) => {
         const raw = mockCache.get(key);
         return raw === undefined ? null : JSON.parse(raw);
      }),
      cacheSetJson: jest.fn(async (key: string, value: unknown, ttl: number) => {
         mockCache.set(key, JSON.stringify(value));
         mockTtls.set(key, ttl);
      }),
      cacheInvalidate: jest.fn(async (...patterns: string[]) => {
         for (const pattern of patterns) {
            const re = toRegex(pattern);
            for (const key of [...mockCache.keys()]) {
               if (re.test(key)) mockCache.delete(key);
            }
         }
      }),
   };
});

const mockPrisma = {
   creatorProfile: {
      findFirst: jest.fn(),
   },
   governanceProposal: {
      findFirst: jest.fn(),
   },
   governanceVotingSnapshot: {
      findUnique: jest.fn(),
   },
};

jest.mock('../../../utils/prisma.utils', () => ({
   prisma: mockPrisma,
}));

import {
   getKeyPollWeight,
   getKeyPollWeightCacheKey,
   invalidateKeyPollWeightCache,
   KeyNotFoundError,
   PollNotFoundError,
   POLL_WEIGHT_CACHE_TTL_SECONDS,
} from '../key-poll-weight.service';
import { cacheSetJson } from '../../../utils/redis.utils';

describe('key-poll-weight.service', () => {
   const KEY_ID = 'creator-123';
   const POLL_ID = 'poll-abc';
   const WALLET = 'GAVOTER1234567890';
   const SNAPSHOT_BLOCK = 123456;

   beforeEach(() => {
      jest.clearAllMocks();
      mockCache.clear();
      mockTtls.clear();
   });

   it('returns vote weight accurately from snapshot balance', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValueOnce({
         id: KEY_ID,
      });
      mockPrisma.governanceProposal.findFirst.mockResolvedValueOnce({
         proposalId: POLL_ID,
         snapshotLedger: SNAPSHOT_BLOCK,
      });
      mockPrisma.governanceVotingSnapshot.findUnique.mockResolvedValueOnce({
         weight: new Decimal('150.5'),
      });

      const result = await getKeyPollWeight(KEY_ID, POLL_ID, WALLET);

      expect(result).toEqual({
         key_id: KEY_ID,
         poll_id: POLL_ID,
         wallet: WALLET,
         vote_weight: '150.5',
         snapshot_block: SNAPSHOT_BLOCK,
      });

      expect(mockPrisma.creatorProfile.findFirst).toHaveBeenCalledWith({
         where: { OR: [{ id: KEY_ID }, { handle: KEY_ID }] },
         select: { id: true },
      });
      expect(mockPrisma.governanceProposal.findFirst).toHaveBeenCalledWith({
         where: {
            keyId: KEY_ID,
            OR: [{ proposalId: POLL_ID }, { id: POLL_ID }],
         },
         select: { proposalId: true, snapshotLedger: true },
      });
      expect(mockPrisma.governanceVotingSnapshot.findUnique).toHaveBeenCalledWith({
         where: {
            keyId_proposalId_wallet: {
               keyId: KEY_ID,
               proposalId: POLL_ID,
               wallet: WALLET,
            },
         },
         select: { weight: true },
      });

      // Verifies cache was written with 60s TTL
      const cacheKey = getKeyPollWeightCacheKey(KEY_ID, POLL_ID, WALLET);
      expect(cacheSetJson).toHaveBeenCalledWith(
         cacheKey,
         result,
         POLL_WEIGHT_CACHE_TTL_SECONDS
      );
   });

   it('returns zero weight correctly for wallets with no snapshot balance', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValueOnce({
         id: KEY_ID,
      });
      mockPrisma.governanceProposal.findFirst.mockResolvedValueOnce({
         proposalId: POLL_ID,
         snapshotLedger: SNAPSHOT_BLOCK,
      });
      mockPrisma.governanceVotingSnapshot.findUnique.mockResolvedValueOnce(null);

      const result = await getKeyPollWeight(KEY_ID, POLL_ID, WALLET);

      expect(result).toEqual({
         key_id: KEY_ID,
         poll_id: POLL_ID,
         wallet: WALLET,
         vote_weight: '0',
         snapshot_block: SNAPSHOT_BLOCK,
      });
   });

   it('uses cached result when available and executes under 200ms', async () => {
      const cachedData = {
         key_id: KEY_ID,
         poll_id: POLL_ID,
         wallet: WALLET,
         vote_weight: '500',
         snapshot_block: SNAPSHOT_BLOCK,
      };
      const cacheKey = getKeyPollWeightCacheKey(KEY_ID, POLL_ID, WALLET);
      mockCache.set(cacheKey, JSON.stringify(cachedData));

      const startTime = Date.now();
      const result = await getKeyPollWeight(KEY_ID, POLL_ID, WALLET);
      const duration = Date.now() - startTime;

      expect(result).toEqual(cachedData);
      expect(duration).toBeLessThan(200);
      expect(mockPrisma.creatorProfile.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.governanceProposal.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.governanceVotingSnapshot.findUnique).not.toHaveBeenCalled();
   });

   it('throws KeyNotFoundError when creator key is not found', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValueOnce(null);

      await expect(
         getKeyPollWeight('non-existent', POLL_ID, WALLET)
      ).rejects.toThrow(KeyNotFoundError);
   });

   it('throws PollNotFoundError when proposal / poll is not found', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValueOnce({
         id: KEY_ID,
      });
      mockPrisma.governanceProposal.findFirst.mockResolvedValueOnce(null);

      await expect(
         getKeyPollWeight(KEY_ID, 'non-existent-poll', WALLET)
      ).rejects.toThrow(PollNotFoundError);
   });

   it('invalidates cache correctly', async () => {
      const cacheKey = getKeyPollWeightCacheKey(KEY_ID, POLL_ID, WALLET);
      mockCache.set(cacheKey, JSON.stringify({ vote_weight: '10' }));

      await invalidateKeyPollWeightCache(KEY_ID, POLL_ID, WALLET);

      expect(mockCache.has(cacheKey)).toBe(false);
   });
});
