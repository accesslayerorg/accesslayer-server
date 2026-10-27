// src/modules/keys/__tests__/key-tipping.service.test.ts
import { Decimal } from '@prisma/client/runtime/library';

let cacheStore = new Map<string, any>();

jest.mock('../../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
   cacheSetJson: jest.fn(async (key: string, val: any) => {
      cacheStore.set(key, val);
   }),
   cacheInvalidate: jest.fn(async (key: string) => {
      cacheStore.delete(key);
   }),
}));

const prismaMock = {
   creatorProfile: {
      findUnique: jest.fn(),
   },
   keyTip: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      aggregate: jest.fn(),
      count: jest.fn(),
   },
};

jest.mock('../../../utils/prisma.utils', () => ({
   prisma: prismaMock,
}));

import {
   getKeyTips,
   getKeyTipsTotal,
   getTipMessage,
   invalidateKeyTipsCache,
   KeyNotFoundError,
   TipNotFoundError,
} from '../key-tipping.service';

describe('key-tipping.service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      cacheStore.clear();
   });

   describe('getKeyTips', () => {
      it('throws KeyNotFoundError if key does not exist', async () => {
         prismaMock.creatorProfile.findUnique.mockResolvedValueOnce(null);

         await expect(getKeyTips('missing-key')).rejects.toThrow(KeyNotFoundError);
      });

      it('returns paginated tip list accurately', async () => {
         const createdAt = new Date('2026-05-01T12:00:00Z');
         prismaMock.creatorProfile.findUnique.mockResolvedValueOnce({ id: 'k1' });
         prismaMock.keyTip.findMany.mockResolvedValueOnce([
            {
               id: 'tip-1',
               tipper: 'GTIPPER1',
               amount: new Decimal('100'),
               messageHash: '0xhash1',
               messageCid: 'bafy1',
               createdAt,
            },
         ]);

         const res = await getKeyTips('k1', 10);

         expect(res.key_id).toBe('k1');
         expect(res.total).toBe(1);
         expect(res.has_more).toBe(false);
         expect(res.tips[0]).toEqual({
            id: 'tip-1',
            tipper: 'GTIPPER1',
            amount: '100',
            message_hash: '0xhash1',
            message_cid: 'bafy1',
            created_at: createdAt.toISOString(),
         });
      });
   });

   describe('getKeyTipsTotal', () => {
      it('returns cumulative total and tip count', async () => {
         prismaMock.creatorProfile.findUnique.mockResolvedValueOnce({ id: 'k2' });
         prismaMock.keyTip.aggregate.mockResolvedValueOnce({
            _sum: { amount: new Decimal('1500.5') },
         });
         prismaMock.keyTip.count.mockResolvedValueOnce(5);

         const res = await getKeyTipsTotal('k2');

         expect(res.key_id).toBe('k2');
         expect(res.total_amount).toBe('1500.5');
         expect(res.tip_count).toBe(5);
      });

      it('returns zero when no tips received', async () => {
         prismaMock.creatorProfile.findUnique.mockResolvedValueOnce({ id: 'k2-empty' });
         prismaMock.keyTip.aggregate.mockResolvedValueOnce({
            _sum: { amount: null },
         });
         prismaMock.keyTip.count.mockResolvedValueOnce(0);

         const res = await getKeyTipsTotal('k2-empty');

         expect(res.total_amount).toBe('0');
         expect(res.tip_count).toBe(0);
      });
   });

   describe('getTipMessage', () => {
      it('throws TipNotFoundError if tip does not exist', async () => {
         prismaMock.keyTip.findFirst.mockResolvedValueOnce(null);

         await expect(getTipMessage('k3', 'nonexistent-tip')).rejects.toThrow(TipNotFoundError);
      });

      it('returns tip message content and cid', async () => {
         prismaMock.keyTip.findFirst.mockResolvedValueOnce({
            id: 'tip-3',
            keyId: 'k3',
            messageCid: 'bafytest',
            messageText: 'Great creator content!',
         });

         const res = await getTipMessage('k3', 'tip-3');

         expect(res.tip_id).toBe('tip-3');
         expect(res.message_cid).toBe('bafytest');
         expect(res.content).toBe('Great creator content!');
      });
   });

   describe('invalidateKeyTipsCache', () => {
      it('clears total and list caches', async () => {
         cacheStore.set('key:tips:total:k-inv', true);
         await invalidateKeyTipsCache('k-inv');
         expect(cacheStore.has('key:tips:total:k-inv')).toBe(false);
      });
   });
});
