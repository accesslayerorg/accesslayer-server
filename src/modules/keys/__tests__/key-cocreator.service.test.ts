// src/modules/keys/__tests__/key-cocreator.service.test.ts
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
   keyCoCreator: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
   },
};

jest.mock('../../../utils/prisma.utils', () => ({
   prisma: prismaMock,
}));

import {
   getCoCreators,
   getCoCreatorDetail,
   invalidateCoCreatorCache,
   KeyNotFoundError,
   CoCreatorNotFoundError,
} from '../key-cocreator.service';

describe('key-cocreator.service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      cacheStore.clear();
   });

   describe('getCoCreators', () => {
      it('throws KeyNotFoundError if key does not exist', async () => {
         prismaMock.creatorProfile.findUnique.mockResolvedValueOnce(null);

         await expect(getCoCreators('missing-key')).rejects.toThrow(KeyNotFoundError);
      });

      it('returns empty list when no active co-creators exist', async () => {
         prismaMock.creatorProfile.findUnique.mockResolvedValueOnce({ id: 'key-1' });
         prismaMock.keyCoCreator.findMany.mockResolvedValueOnce([]);

         const res = await getCoCreators('key-1');

         expect(res.key_id).toBe('key-1');
         expect(res.co_creators).toEqual([]);
         expect(res.total).toBe(0);
      });

      it('returns active co-creators accurately', async () => {
         const addedAt = new Date('2026-01-01T00:00:00Z');
         prismaMock.creatorProfile.findUnique.mockResolvedValueOnce({ id: 'key-2' });
         prismaMock.keyCoCreator.findMany.mockResolvedValueOnce([
            { wallet: 'GAAA...', role: 'admin', addedAt },
            { wallet: 'GBBB...', role: 'contributor', addedAt },
         ]);

         const res = await getCoCreators('key-2');

         expect(res.key_id).toBe('key-2');
         expect(res.total).toBe(2);
         expect(res.co_creators).toEqual([
            { wallet: 'GAAA...', role: 'admin', added_at: addedAt.toISOString() },
            { wallet: 'GBBB...', role: 'contributor', added_at: addedAt.toISOString() },
         ]);
      });

      it('returns cached list if present', async () => {
         const cached = {
            key_id: 'key-cached',
            co_creators: [{ wallet: 'GCCC...', role: 'editor', added_at: '2026-01-01T00:00:00.000Z' }],
            total: 1,
         };
         cacheStore.set('key:co-creators:key-cached', cached);

         const res = await getCoCreators('key-cached');

         expect(res).toEqual(cached);
         expect(prismaMock.creatorProfile.findUnique).not.toHaveBeenCalled();
      });
   });

   describe('getCoCreatorDetail', () => {
      it('throws KeyNotFoundError if key does not exist', async () => {
         prismaMock.creatorProfile.findUnique.mockResolvedValueOnce(null);

         await expect(getCoCreatorDetail('missing-key', 'GXXX')).rejects.toThrow(KeyNotFoundError);
      });

      it('throws CoCreatorNotFoundError if co-creator not active or absent', async () => {
         prismaMock.creatorProfile.findUnique.mockResolvedValueOnce({ id: 'key-3' });
         prismaMock.keyCoCreator.findFirst.mockResolvedValueOnce(null);

         await expect(getCoCreatorDetail('key-3', 'GNOTFOUND')).rejects.toThrow(CoCreatorNotFoundError);
      });

      it('returns co-creator detail with correct role and added_at', async () => {
         const addedAt = new Date('2026-02-01T12:00:00Z');
         prismaMock.creatorProfile.findUnique.mockResolvedValueOnce({ id: 'key-3' });
         prismaMock.keyCoCreator.findFirst.mockResolvedValueOnce({
            wallet: 'GVALID...',
            role: 'curator',
            addedAt,
         });

         const res = await getCoCreatorDetail('key-3', 'GVALID...');

         expect(res.key_id).toBe('key-3');
         expect(res.wallet).toBe('GVALID...');
         expect(res.role).toBe('curator');
         expect(res.added_at).toBe(addedAt.toISOString());
      });

      it('returns cached detail if present', async () => {
         const cached = {
            key_id: 'key-detail-cached',
            wallet: 'GWALLET',
            role: 'signer',
            added_at: '2026-02-01T00:00:00.000Z',
         };
         cacheStore.set('key:co-creators:key-detail-cached:GWALLET', cached);

         const res = await getCoCreatorDetail('key-detail-cached', 'GWALLET');

         expect(res).toEqual(cached);
         expect(prismaMock.creatorProfile.findUnique).not.toHaveBeenCalled();
      });
   });

   describe('invalidateCoCreatorCache', () => {
      it('invalidates both list and detail cache if wallet provided', async () => {
         cacheStore.set('key:co-creators:key-test', { foo: 'bar' });
         cacheStore.set('key:co-creators:key-test:W1', { detail: 'data' });

         await invalidateCoCreatorCache('key-test', 'W1');

         expect(cacheStore.has('key:co-creators:key-test')).toBe(false);
         expect(cacheStore.has('key:co-creators:key-test:W1')).toBe(false);
      });
   });
});
