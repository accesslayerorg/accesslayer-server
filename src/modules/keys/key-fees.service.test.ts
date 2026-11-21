// src/modules/keys/key-fees.service.test.ts
const redisStore = new Map<string, string>();

jest.mock('../../utils/redis.utils', () => ({
   getRedis: () => ({
      get: jest.fn(async (key: string) => redisStore.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
         redisStore.set(key, value);
         return 'OK';
      }),
      del: jest.fn(async (key: string) => {
         redisStore.delete(key);
         return 1;
      }),
      pipeline: () => {
         const ops: Array<() => void> = [];
         const api = {
            del: (key: string) => {
               ops.push(() => {
                  redisStore.delete(key);
               });
               return api;
            },
            exec: async () => {
               ops.forEach(op => op());
               return [];
            },
         };
         return api;
      },
   }),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      protocolConfig: {
         upsert: jest.fn(),
      },
      creatorProfile: {
         findUnique: jest.fn(),
         findMany: jest.fn(),
         update: jest.fn(),
      },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import {
   getKeyFees,
   invalidateKeyFeesCache,
   KeyNotFoundError,
   updateProtocolFeeBps,
} from './key-fees.service';
import { REDIS_KEYS } from '../../constants/notifications.constants';

describe('key-fees.service', () => {
   beforeEach(() => {
      redisStore.clear();
      jest.clearAllMocks();
   });

   it('returns fees from DB and caches them in Redis', async () => {
      (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue({
         creatorRoyaltyBuyBps: 200,
         creatorRoyaltySellBps: 100,
      });
      (prisma.protocolConfig.upsert as jest.Mock).mockResolvedValue({
         protocolFeeBps: 500,
      });

      const fees = await getKeyFees('key-1');
      expect(fees).toEqual({
         protocolFeeBps: 500,
         creatorRoyaltyBuyBps: 200,
         creatorRoyaltySellBps: 100,
      });

      // Second call should hit cache (no extra DB reads for creator)
      (prisma.creatorProfile.findUnique as jest.Mock).mockClear();
      (prisma.protocolConfig.upsert as jest.Mock).mockClear();
      const cached = await getKeyFees('key-1');
      expect(cached).toEqual(fees);
      expect(prisma.creatorProfile.findUnique).not.toHaveBeenCalled();
      expect(prisma.protocolConfig.upsert).not.toHaveBeenCalled();
   });

   it('throws KeyNotFoundError for unknown key IDs', async () => {
      (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(getKeyFees('missing')).rejects.toBeInstanceOf(
         KeyNotFoundError
      );
   });

   it('invalidates cache when protocol fee is updated', async () => {
      redisStore.set(
         REDIS_KEYS.keyFees('key-1'),
         JSON.stringify({
            protocolFeeBps: 500,
            creatorRoyaltyBuyBps: 0,
            creatorRoyaltySellBps: 0,
         })
      );
      (prisma.protocolConfig.upsert as jest.Mock).mockResolvedValue({
         protocolFeeBps: 750,
      });
      (prisma.creatorProfile.findMany as jest.Mock).mockResolvedValue([
         { id: 'key-1' },
      ]);

      await updateProtocolFeeBps(750);
      expect(redisStore.has(REDIS_KEYS.keyFees('key-1'))).toBe(false);
   });

   it('invalidateKeyFeesCache removes a single key entry', async () => {
      redisStore.set(REDIS_KEYS.keyFees('key-1'), '{}');
      await invalidateKeyFeesCache('key-1');
      expect(redisStore.has(REDIS_KEYS.keyFees('key-1'))).toBe(false);
   });
});
