// src/modules/collections/collections.service.test.ts

jest.mock('../../utils/prisma.utils', () => {
   const mockTx = {
      collection: { update: jest.fn() },
      collectionItem: {
         count: jest.fn(),
         aggregate: jest.fn(),
         create: jest.fn(),
         findMany: jest.fn(),
         updateMany: jest.fn(),
         update: jest.fn(),
      },
      collectionFollow: {
         createMany: jest.fn(),
         deleteMany: jest.fn(),
      },
   };
   return {
      prisma: {
         collection: {
            findUnique: jest.fn(),
            findMany: jest.fn(),
            count: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
         },
         collectionItem: { findMany: jest.fn(), deleteMany: jest.fn() },
         collectionFollow: { findMany: jest.fn() },
         creatorProfile: { findMany: jest.fn(), findFirst: jest.fn() },
         keyFreeze: { findMany: jest.fn() },
         keyReport: { findMany: jest.fn() },
         $transaction: jest.fn(async (cb: any) => cb(mockTx)),
         __mockTx: mockTx,
      },
   };
});

jest.mock('../outbox/outbox.service', () => ({
   OutboxService: { enqueue: jest.fn(async () => 'outbox-1') },
}));

import { prisma } from '../../utils/prisma.utils';
import { OutboxService } from '../outbox/outbox.service';
import {
   COLLECTION_ITEM_ADDED_EVENT,
   MAX_COLLECTION_ITEMS,
   addCollectionItem,
   createCollection,
   filterListableKeyIds,
   followCollection,
   getPublishedCollectionWithItems,
   listFollowedCollectionItemAdds,
   listPublishedCollections,
   reorderCollectionItems,
   unfollowCollection,
   updateCollection,
} from './collections.service';

const mockPrisma = prisma as any;
const mockTx = mockPrisma.__mockTx;

const EDITOR = 'GEDITOR';
const now = new Date('2026-11-24T12:00:00.000Z');

function collection(overrides: Record<string, unknown> = {}) {
   return {
      id: 'c1',
      slug: 'stellar-picks',
      title: 'Stellar picks',
      description: null,
      status: 'PUBLISHED',
      editorWallets: [EDITOR],
      followerCount: 3,
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
      ...overrides,
   };
}

function item(keyId: string, position: number, note: string | null = null) {
   return { keyId, position, note, createdAt: now };
}

function listable(ids: string[]) {
   mockPrisma.creatorProfile.findMany.mockResolvedValue(ids.map(id => ({ id })));
   mockPrisma.keyFreeze.findMany.mockResolvedValue([]);
   mockPrisma.keyReport.findMany.mockResolvedValue([]);
}

function uniqueViolation() {
   return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

describe('collections.service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('filterListableKeyIds', () => {
      it('hides retired, frozen and moderator-flagged keys', async () => {
         // k2 is not Active (retired/deprecated/sunset) so the profile query omits it.
         mockPrisma.creatorProfile.findMany.mockResolvedValue([
            { id: 'k1' },
            { id: 'k3' },
            { id: 'k4' },
            { id: 'k5' },
         ]);
         mockPrisma.keyFreeze.findMany.mockResolvedValue([
            { keyId: 'k3', expiryTimestamp: null },
            { keyId: 'k5', expiryTimestamp: new Date('2026-01-01T00:00:00Z') },
         ]);
         mockPrisma.keyReport.findMany.mockResolvedValue([{ keyId: 'k4' }]);

         const result = await filterListableKeyIds(['k1', 'k2', 'k3', 'k4', 'k5'], now);

         expect([...result].sort()).toEqual(['k1', 'k5']);
         expect(mockPrisma.creatorProfile.findMany).toHaveBeenCalledWith({
            where: {
               id: { in: ['k1', 'k2', 'k3', 'k4', 'k5'] },
               status: 'Active',
               deprecatedAt: null,
               sunsetFlaggedAt: null,
            },
            select: { id: true },
         });
         expect(mockPrisma.keyReport.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
               where: expect.objectContaining({ status: 'actioned' }),
            })
         );
      });

      it('skips queries for an empty list', async () => {
         expect((await filterListableKeyIds([])).size).toBe(0);
         expect(mockPrisma.creatorProfile.findMany).not.toHaveBeenCalled();
      });
   });

   describe('public reads', () => {
      it('lists only published collections with listable item counts', async () => {
         mockPrisma.collection.findMany.mockResolvedValue([collection()]);
         mockPrisma.collection.count.mockResolvedValue(1);
         mockPrisma.collectionItem.findMany.mockResolvedValue([
            { collectionId: 'c1', keyId: 'k1' },
            { collectionId: 'c1', keyId: 'k-frozen' },
         ]);
         listable(['k1']);

         const result = await listPublishedCollections({ page: 1, limit: 20 });

         expect(mockPrisma.collection.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { status: 'PUBLISHED' } })
         );
         expect(mockPrisma.collection.count).toHaveBeenCalledWith({
            where: { status: 'PUBLISHED' },
         });
         expect(result.data).toEqual([
            expect.objectContaining({ slug: 'stellar-picks', itemCount: 1 }),
         ]);
         expect(result.data[0]).not.toHaveProperty('editorWallets');
         expect(result.meta).toEqual({
            page: 1,
            limit: 20,
            totalCount: 1,
            totalPages: 1,
            hasNextPage: false,
            hasPrevPage: false,
         });
      });

      it('returns items ordered by position with notes and hides unlistable keys', async () => {
         mockPrisma.collection.findUnique.mockResolvedValue(collection());
         mockPrisma.collectionItem.findMany.mockResolvedValue([
            item('k1', 0, 'Top pick'),
            item('k-retired', 1),
            item('k2', 2, 'Rising'),
         ]);
         listable(['k1', 'k2']);

         const result = await getPublishedCollectionWithItems('stellar-picks');

         expect(mockPrisma.collectionItem.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ orderBy: { position: 'asc' } })
         );
         expect(result.items.map(i => [i.keyId, i.note])).toEqual([
            ['k1', 'Top pick'],
            ['k2', 'Rising'],
         ]);
         expect(result.itemCount).toBe(2);
      });

      it('treats a draft collection as not found', async () => {
         mockPrisma.collection.findUnique.mockResolvedValue(
            collection({ status: 'DRAFT' })
         );
         await expect(getPublishedCollectionWithItems('stellar-picks')).rejects.toMatchObject({
            statusCode: 404,
         });
      });
   });

   describe('editor writes', () => {
      it('creates a draft with the caller as the only editor', async () => {
         mockPrisma.collection.create.mockResolvedValue(
            collection({ status: 'DRAFT', publishedAt: null })
         );
         await createCollection({ wallet: EDITOR, slug: 'stellar-picks', title: 'Stellar picks' });
         expect(mockPrisma.collection.create).toHaveBeenCalledWith({
            data: {
               slug: 'stellar-picks',
               title: 'Stellar picks',
               description: null,
               editorWallets: [EDITOR],
            },
         });
      });

      it('maps a duplicate slug to 409', async () => {
         mockPrisma.collection.create.mockRejectedValue(uniqueViolation());
         await expect(
            createCollection({ wallet: EDITOR, slug: 'stellar-picks', title: 'x' })
         ).rejects.toMatchObject({ statusCode: 409 });
      });

      it('rejects writes from wallets that are not editors', async () => {
         mockPrisma.collection.findUnique.mockResolvedValue(collection());
         await expect(
            updateCollection({ wallet: 'GSTRANGER', slug: 'stellar-picks', title: 'x' })
         ).rejects.toMatchObject({ statusCode: 403 });
         expect(mockPrisma.collection.update).not.toHaveBeenCalled();
      });

      it('stamps publishedAt the first time a collection is published', async () => {
         mockPrisma.collection.findUnique.mockResolvedValue(
            collection({ status: 'DRAFT', publishedAt: null })
         );
         mockPrisma.collection.update.mockResolvedValue(collection());
         mockPrisma.collectionItem.findMany.mockResolvedValue([]);

         await updateCollection({ wallet: EDITOR, slug: 'stellar-picks', status: 'PUBLISHED' });

         const { data } = mockPrisma.collection.update.mock.calls[0][0];
         expect(data.status).toBe('PUBLISHED');
         expect(data.publishedAt).toBeInstanceOf(Date);
      });

      it('appends an item after the current last position and emits one event', async () => {
         mockPrisma.collection.findUnique.mockResolvedValue(collection());
         mockPrisma.creatorProfile.findFirst.mockResolvedValue({ id: 'k9' });
         mockTx.collectionItem.count.mockResolvedValue(2);
         mockTx.collectionItem.aggregate.mockResolvedValue({ _max: { position: 4 } });
         mockTx.collectionItem.create.mockResolvedValue(item('k9', 5, 'New'));

         const result = await addCollectionItem({
            wallet: EDITOR,
            slug: 'stellar-picks',
            keyId: 'k9-handle',
            note: 'New',
         });

         expect(mockTx.collection.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'c1' } })
         );
         expect(mockTx.collectionItem.create).toHaveBeenCalledWith(
            expect.objectContaining({
               data: expect.objectContaining({ keyId: 'k9', position: 5, note: 'New', addedBy: EDITOR }),
            })
         );
         expect(OutboxService.enqueue).toHaveBeenCalledTimes(1);
         expect(OutboxService.enqueue).toHaveBeenCalledWith(
            mockTx,
            COLLECTION_ITEM_ADDED_EVENT,
            expect.objectContaining({ collectionId: 'c1', slug: 'stellar-picks', keyId: 'k9' })
         );
         expect(result).toEqual(expect.objectContaining({ keyId: 'k9', position: 5 }));
      });

      it('starts positions at 0 for an empty collection', async () => {
         mockPrisma.collection.findUnique.mockResolvedValue(collection());
         mockPrisma.creatorProfile.findFirst.mockResolvedValue({ id: 'k1' });
         mockTx.collectionItem.count.mockResolvedValue(0);
         mockTx.collectionItem.aggregate.mockResolvedValue({ _max: { position: null } });
         mockTx.collectionItem.create.mockResolvedValue(item('k1', 0));

         await addCollectionItem({ wallet: EDITOR, slug: 'stellar-picks', keyId: 'k1' });

         expect(mockTx.collectionItem.create.mock.calls[0][0].data.position).toBe(0);
      });

      it('rejects a duplicate key with 409 and emits nothing', async () => {
         mockPrisma.collection.findUnique.mockResolvedValue(collection());
         mockPrisma.creatorProfile.findFirst.mockResolvedValue({ id: 'k1' });
         mockTx.collectionItem.count.mockResolvedValue(1);
         mockTx.collectionItem.aggregate.mockResolvedValue({ _max: { position: 0 } });
         mockTx.collectionItem.create.mockRejectedValue(uniqueViolation());

         await expect(
            addCollectionItem({ wallet: EDITOR, slug: 'stellar-picks', keyId: 'k1' })
         ).rejects.toMatchObject({ statusCode: 409 });
         expect(OutboxService.enqueue).not.toHaveBeenCalled();
      });

      it('caps the number of items per collection', async () => {
         mockPrisma.collection.findUnique.mockResolvedValue(collection());
         mockPrisma.creatorProfile.findFirst.mockResolvedValue({ id: 'k1' });
         mockTx.collectionItem.count.mockResolvedValue(MAX_COLLECTION_ITEMS);
         mockTx.collectionItem.aggregate.mockResolvedValue({ _max: { position: 99 } });

         await expect(
            addCollectionItem({ wallet: EDITOR, slug: 'stellar-picks', keyId: 'k1' })
         ).rejects.toMatchObject({ statusCode: 422 });
         expect(mockTx.collectionItem.create).not.toHaveBeenCalled();
      });

      it('returns 404 for an unknown key', async () => {
         mockPrisma.collection.findUnique.mockResolvedValue(collection());
         mockPrisma.creatorProfile.findFirst.mockResolvedValue(null);
         await expect(
            addCollectionItem({ wallet: EDITOR, slug: 'stellar-picks', keyId: 'nope' })
         ).rejects.toMatchObject({ statusCode: 404 });
      });
   });

   describe('reorderCollectionItems', () => {
      beforeEach(() => {
         mockPrisma.collection.findUnique.mockResolvedValue(collection());
      });

      it('moves positions out of the way, then writes unique 0..n-1 positions', async () => {
         mockTx.collectionItem.findMany
            .mockResolvedValueOnce([item('a', 0), item('b', 1), item('c', 2)])
            .mockResolvedValueOnce([item('c', 0), item('a', 1), item('b', 2)]);

         const result = await reorderCollectionItems({
            wallet: EDITOR,
            slug: 'stellar-picks',
            orderedKeyIds: ['c', 'a', 'b'],
         });

         expect(mockTx.collectionItem.updateMany).toHaveBeenCalledWith({
            where: { collectionId: 'c1' },
            data: { position: { decrement: MAX_COLLECTION_ITEMS * 10 } },
         });
         const finalWrites = mockTx.collectionItem.update.mock.calls.map(
            ([args]: any[]) => [args.where.collectionId_keyId.keyId, args.data.position]
         );
         expect(finalWrites).toEqual([
            ['c', 0],
            ['a', 1],
            ['b', 2],
         ]);
         expect(new Set(finalWrites.map(([, p]: any[]) => p)).size).toBe(3);
         // The bulk offset runs before any final position write.
         expect(mockTx.collectionItem.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
            mockTx.collectionItem.update.mock.invocationCallOrder[0]
         );
         expect(result.map(i => i.keyId)).toEqual(['c', 'a', 'b']);
      });

      it.each([
         ['a missing key', ['a', 'b']],
         ['a duplicate key', ['a', 'a', 'b']],
         ['an unknown key', ['a', 'b', 'z']],
      ])('rejects an order with %s', async (_label, orderedKeyIds) => {
         mockTx.collectionItem.findMany.mockResolvedValueOnce([
            item('a', 0),
            item('b', 1),
            item('c', 2),
         ]);
         await expect(
            reorderCollectionItems({ wallet: EDITOR, slug: 'stellar-picks', orderedKeyIds })
         ).rejects.toMatchObject({ statusCode: 400 });
         expect(mockTx.collectionItem.updateMany).not.toHaveBeenCalled();
      });
   });

   describe('follows', () => {
      it('increments the follower count only when the follow is new', async () => {
         mockPrisma.collection.findUnique.mockResolvedValue(collection());
         mockTx.collectionFollow.createMany.mockResolvedValueOnce({ count: 1 });
         mockTx.collection.update.mockResolvedValueOnce({ followerCount: 4 });

         expect(await followCollection({ wallet: 'GFAN', slug: 'stellar-picks' })).toEqual({
            following: true,
            followerCount: 4,
         });
         expect(mockTx.collectionFollow.createMany).toHaveBeenCalledWith({
            data: [{ collectionId: 'c1', walletAddress: 'GFAN' }],
            skipDuplicates: true,
         });

         mockTx.collectionFollow.createMany.mockResolvedValueOnce({ count: 0 });
         mockPrisma.collection.findUnique.mockResolvedValue(collection({ followerCount: 4 }));
         expect(await followCollection({ wallet: 'GFAN', slug: 'stellar-picks' })).toEqual({
            following: true,
            followerCount: 4,
         });
         expect(mockTx.collection.update).toHaveBeenCalledTimes(1);
      });

      it('does not allow following a draft', async () => {
         mockPrisma.collection.findUnique.mockResolvedValue(collection({ status: 'DRAFT' }));
         await expect(
            followCollection({ wallet: 'GFAN', slug: 'stellar-picks' })
         ).rejects.toMatchObject({ statusCode: 404 });
      });

      it('decrements only when a follow existed', async () => {
         mockPrisma.collection.findUnique.mockResolvedValue(collection());
         mockTx.collectionFollow.deleteMany.mockResolvedValueOnce({ count: 0 });
         expect(await unfollowCollection({ wallet: 'GFAN', slug: 'stellar-picks' })).toEqual({
            following: false,
            followerCount: 3,
         });
         expect(mockTx.collection.update).not.toHaveBeenCalled();
      });

      it('lists additions made after the wallet followed, hiding unlistable keys', async () => {
         const followedAt = new Date('2026-11-20T00:00:00Z');
         mockPrisma.collectionFollow.findMany.mockResolvedValue([
            { collectionId: 'c1', createdAt: followedAt },
         ]);
         const row = (keyId: string, createdAt: string) => ({
            keyId,
            note: null,
            createdAt: new Date(createdAt),
            collectionId: 'c1',
            collection: { slug: 'stellar-picks', title: 'Stellar picks' },
         });
         mockPrisma.collectionItem.findMany.mockResolvedValue([
            row('k-new', '2026-11-22T00:00:00Z'),
            row('k-frozen', '2026-11-21T00:00:00Z'),
         ]);
         listable(['k-new']);

         const adds = await listFollowedCollectionItemAdds('GFAN', 50);

         expect(adds.map(a => a.keyId)).toEqual(['k-new']);
         // Pre-follow additions are excluded by the query, so they never use up the limit.
         expect(mockPrisma.collectionItem.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
               where: {
                  OR: [{ collectionId: 'c1', createdAt: { gt: followedAt } }],
                  collection: { status: 'PUBLISHED' },
               },
               take: 50,
            })
         );
      });
   });
});
