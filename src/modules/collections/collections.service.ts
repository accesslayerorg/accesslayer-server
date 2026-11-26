// src/modules/collections/collections.service.ts
// Curated key collections: editor-managed items with ordering and notes,
// published listings that hide unlistable keys, follower tracking, and
// collection.item_added outbox events (#1353).

import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { PaginationMetadata } from '../../utils/api-response.utils';
import { OutboxService } from '../outbox/outbox.service';

/** Upper bound on items per collection; keeps reorder writes bounded. */
export const MAX_COLLECTION_ITEMS = 100;

/** Upper bound on editors per collection. */
export const MAX_COLLECTION_EDITORS = 20;

export const COLLECTION_ITEM_ADDED_EVENT = 'collection.item_added';

export type CollectionStatus = 'DRAFT' | 'PUBLISHED';

/** Prisma client or interactive-transaction handle; helpers need only these models. */
type Db = Pick<typeof prisma, 'collection' | 'collectionItem'>;

export class CollectionServiceError extends Error {
   statusCode: number;
   code: string;

   constructor(statusCode: number, code: string, message: string) {
      super(message);
      this.name = 'CollectionServiceError';
      this.statusCode = statusCode;
      this.code = code;
   }
}

const notFound = () =>
   new CollectionServiceError(404, 'NOT_FOUND', 'Collection not found');

function isUniqueViolation(error: unknown): boolean {
   return (error as { code?: string })?.code === 'P2002';
}

/**
 * Returns the subset of `keyIds` that may appear in public views. A key is
 * hidden when it is retired or deprecated (non-Active status or
 * deprecatedAt set), flagged for sunset, currently frozen (an expired freeze
 * no longer applies), or flagged by moderators through an actioned report.
 * Mirrors the sitemap's indexability rule, plus the moderation flag.
 */
export async function filterListableKeyIds(
   keyIds: string[],
   now: Date = new Date()
): Promise<Set<string>> {
   if (keyIds.length === 0) return new Set();
   const unique = [...new Set(keyIds)];

   const [active, frozen, actioned] = await Promise.all([
      prisma.creatorProfile.findMany({
         where: {
            id: { in: unique },
            status: 'Active',
            deprecatedAt: null,
            sunsetFlaggedAt: null,
         },
         select: { id: true },
      }),
      prisma.keyFreeze.findMany({
         where: { keyId: { in: unique }, isFrozen: true },
         select: { keyId: true, expiryTimestamp: true },
      }),
      prisma.keyReport.findMany({
         where: { keyId: { in: unique }, status: 'actioned' },
         select: { keyId: true },
      }),
   ]);

   const hidden = new Set<string>([
      ...frozen
         .filter(f => !f.expiryTimestamp || f.expiryTimestamp > now)
         .map(f => f.keyId),
      ...actioned.map(r => r.keyId),
   ]);
   return new Set(active.map(k => k.id).filter(id => !hidden.has(id)));
}

type CollectionRow = {
   id: string;
   slug: string;
   title: string;
   description: string | null;
   status: CollectionStatus;
   editorWallets: string[];
   followerCount: number;
   publishedAt: Date | null;
   createdAt: Date;
   updatedAt: Date;
};

type ItemRow = {
   keyId: string;
   position: number;
   note: string | null;
   createdAt: Date;
};

function toPublicSummary(collection: CollectionRow, itemCount: number) {
   return {
      slug: collection.slug,
      title: collection.title,
      description: collection.description,
      followerCount: collection.followerCount,
      itemCount,
      publishedAt: collection.publishedAt,
   };
}

function toPublicItem(item: ItemRow) {
   return {
      keyId: item.keyId,
      position: item.position,
      note: item.note,
      addedAt: item.createdAt,
   };
}

/** Editors see every field, including drafts, editors and unlisted keys. */
function toEditorView(collection: CollectionRow, items: ItemRow[]) {
   return {
      ...collection,
      items: items.map(toPublicItem),
   };
}

async function getCollectionBySlug(db: Db, slug: string) {
   const collection = (await db.collection.findUnique({
      where: { slug },
   })) as CollectionRow | null;
   if (!collection) throw notFound();
   return collection;
}

async function getPublishedCollection(slug: string) {
   const collection = (await prisma.collection.findUnique({
      where: { slug },
   })) as CollectionRow | null;
   // Drafts are indistinguishable from missing collections publicly.
   if (!collection || collection.status !== 'PUBLISHED') throw notFound();
   return collection;
}

function assertEditor(collection: CollectionRow, wallet: string): void {
   if (!collection.editorWallets.includes(wallet)) {
      throw new CollectionServiceError(
         403,
         'FORBIDDEN',
         'Only collection editors can change this collection'
      );
   }
}

/**
 * Takes a row lock on the collection so concurrent item writes for the same
 * collection serialize; position calculations then see committed rows.
 */
async function lockCollection(tx: Db, collectionId: string): Promise<void> {
   await tx.collection.update({
      where: { id: collectionId },
      data: { updatedAt: new Date() },
   });
}

async function loadItems(db: Db, collectionId: string) {
   return (await db.collectionItem.findMany({
      where: { collectionId },
      orderBy: { position: 'asc' },
      select: { keyId: true, position: true, note: true, createdAt: true },
   })) as ItemRow[];
}

// ── Public reads ────────────────────────────────────────────

export async function listPublishedCollections(params: {
   page: number;
   limit: number;
}): Promise<{
   data: ReturnType<typeof toPublicSummary>[];
   meta: PaginationMetadata;
}> {
   const where = { status: 'PUBLISHED' as const };
   const [rows, totalCount] = await Promise.all([
      prisma.collection.findMany({
         where,
         orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
         skip: (params.page - 1) * params.limit,
         take: params.limit,
      }),
      prisma.collection.count({ where }),
   ]);
   const collections = rows as CollectionRow[];

   const items = collections.length
      ? ((await prisma.collectionItem.findMany({
           where: { collectionId: { in: collections.map(c => c.id) } },
           select: { collectionId: true, keyId: true },
        })) as Array<{ collectionId: string; keyId: string }>)
      : [];
   const listable = await filterListableKeyIds(items.map(i => i.keyId));
   const counts = new Map<string, number>();
   for (const item of items) {
      if (!listable.has(item.keyId)) continue;
      counts.set(item.collectionId, (counts.get(item.collectionId) ?? 0) + 1);
   }

   const totalPages = Math.max(1, Math.ceil(totalCount / params.limit));
   return {
      data: collections.map(c => toPublicSummary(c, counts.get(c.id) ?? 0)),
      meta: {
         page: params.page,
         limit: params.limit,
         totalCount,
         totalPages,
         hasNextPage: params.page < totalPages,
         hasPrevPage: params.page > 1,
      },
   };
}

/** Published collection with its listable items ordered by position. */
export async function getPublishedCollectionWithItems(slug: string) {
   const collection = await getPublishedCollection(slug);
   const items = await loadItems(prisma, collection.id);
   const listable = await filterListableKeyIds(items.map(i => i.keyId));
   const visible = items.filter(i => listable.has(i.keyId));
   return {
      ...toPublicSummary(collection, visible.length),
      items: visible.map(toPublicItem),
   };
}

// ── Editor writes ───────────────────────────────────────────

export async function createCollection(input: {
   wallet: string;
   slug: string;
   title: string;
   description?: string;
}) {
   try {
      const collection = (await prisma.collection.create({
         data: {
            slug: input.slug,
            title: input.title,
            description: input.description ?? null,
            editorWallets: [input.wallet],
         },
      })) as CollectionRow;
      return toEditorView(collection, []);
   } catch (error) {
      if (isUniqueViolation(error)) {
         throw new CollectionServiceError(
            409,
            'CONFLICT',
            'A collection with this slug already exists'
         );
      }
      throw error;
   }
}

export async function updateCollection(input: {
   wallet: string;
   slug: string;
   title?: string;
   description?: string | null;
   status?: CollectionStatus;
   editorWallets?: string[];
}) {
   const collection = await getCollectionBySlug(prisma, input.slug);
   assertEditor(collection, input.wallet);

   const data: Prisma.CollectionUpdateInput = {};
   if (input.title !== undefined) data.title = input.title;
   if (input.description !== undefined) data.description = input.description;
   if (input.editorWallets !== undefined) {
      data.editorWallets = [...new Set(input.editorWallets)];
   }
   if (input.status !== undefined) {
      data.status = input.status;
      if (input.status === 'PUBLISHED' && !collection.publishedAt) {
         data.publishedAt = new Date();
      }
   }

   const updated = (await prisma.collection.update({
      where: { id: collection.id },
      data,
   })) as CollectionRow;
   return toEditorView(updated, await loadItems(prisma, updated.id));
}

/**
 * Appends a key to the collection and emits exactly one
 * `collection.item_added` event in the same transaction.
 */
export async function addCollectionItem(input: {
   wallet: string;
   slug: string;
   keyId: string;
   note?: string;
}) {
   const collection = await getCollectionBySlug(prisma, input.slug);
   assertEditor(collection, input.wallet);

   const key = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: input.keyId }, { handle: input.keyId }] },
      select: { id: true },
   });
   if (!key) {
      throw new CollectionServiceError(404, 'NOT_FOUND', 'Key not found');
   }

   try {
      return await prisma.$transaction(async tx => {
         await lockCollection(tx, collection.id);

         const [count, max] = await Promise.all([
            tx.collectionItem.count({ where: { collectionId: collection.id } }),
            tx.collectionItem.aggregate({
               where: { collectionId: collection.id },
               _max: { position: true },
            }),
         ]);
         if (count >= MAX_COLLECTION_ITEMS) {
            throw new CollectionServiceError(
               422,
               'UNPROCESSABLE_ENTITY',
               `A collection can hold at most ${MAX_COLLECTION_ITEMS} keys`
            );
         }

         const item = (await tx.collectionItem.create({
            data: {
               collectionId: collection.id,
               keyId: key.id,
               position: (max._max.position ?? -1) + 1,
               note: input.note ?? null,
               addedBy: input.wallet,
            },
            select: { keyId: true, position: true, note: true, createdAt: true },
         })) as ItemRow;

         await OutboxService.enqueue(
            tx as unknown as typeof prisma,
            COLLECTION_ITEM_ADDED_EVENT,
            {
               collectionId: collection.id,
               slug: collection.slug,
               keyId: item.keyId,
               position: item.position,
               addedBy: input.wallet,
               followerCount: collection.followerCount,
            }
         );

         return toPublicItem(item);
      });
   } catch (error) {
      if (isUniqueViolation(error)) {
         throw new CollectionServiceError(
            409,
            'CONFLICT',
            'This key is already in the collection'
         );
      }
      throw error;
   }
}

export async function removeCollectionItem(input: {
   wallet: string;
   slug: string;
   keyId: string;
}) {
   const collection = await getCollectionBySlug(prisma, input.slug);
   assertEditor(collection, input.wallet);

   const result = await prisma.collectionItem.deleteMany({
      where: { collectionId: collection.id, keyId: input.keyId },
   });
   if (result.count === 0) {
      throw new CollectionServiceError(
         404,
         'NOT_FOUND',
         'Key is not in this collection'
      );
   }
}

/**
 * Rewrites positions to match `orderedKeyIds` (0..n-1). `orderedKeyIds` must
 * list every key in the collection exactly once. Positions are first moved
 * to distinct negative values in one statement so the final writes never
 * collide with the (collectionId, position) unique index.
 */
export async function reorderCollectionItems(input: {
   wallet: string;
   slug: string;
   orderedKeyIds: string[];
}) {
   const collection = await getCollectionBySlug(prisma, input.slug);
   assertEditor(collection, input.wallet);

   return prisma.$transaction(async tx => {
      await lockCollection(tx, collection.id);

      const current = await loadItems(tx, collection.id);
      const currentIds = new Set(current.map(i => i.keyId));
      const requested = new Set(input.orderedKeyIds);
      const isPermutation =
         requested.size === input.orderedKeyIds.length &&
         requested.size === currentIds.size &&
         [...requested].every(id => currentIds.has(id));
      if (!isPermutation) {
         throw new CollectionServiceError(
            400,
            'VALIDATION_ERROR',
            'orderedKeyIds must list every key in the collection exactly once'
         );
      }

      await tx.collectionItem.updateMany({
         where: { collectionId: collection.id },
         data: { position: { decrement: MAX_COLLECTION_ITEMS * 10 } },
      });
      for (const [position, keyId] of input.orderedKeyIds.entries()) {
         await tx.collectionItem.update({
            where: { collectionId_keyId: { collectionId: collection.id, keyId } },
            data: { position },
         });
      }

      return (await loadItems(tx, collection.id)).map(toPublicItem);
   });
}

// ── Follows ─────────────────────────────────────────────────

/** Idempotent: a wallet follows a collection at most once. */
export async function followCollection(input: { wallet: string; slug: string }) {
   const collection = await getPublishedCollection(input.slug);
   return prisma.$transaction(async tx => {
      const created = await tx.collectionFollow.createMany({
         data: [{ collectionId: collection.id, walletAddress: input.wallet }],
         skipDuplicates: true,
      });
      const updated =
         created.count > 0
            ? await tx.collection.update({
                 where: { id: collection.id },
                 data: { followerCount: { increment: 1 } },
                 select: { followerCount: true },
              })
            : { followerCount: collection.followerCount };
      return { following: true, followerCount: updated.followerCount };
   });
}

export async function unfollowCollection(input: {
   wallet: string;
   slug: string;
}) {
   const collection = await getCollectionBySlug(prisma, input.slug);
   return prisma.$transaction(async tx => {
      const removed = await tx.collectionFollow.deleteMany({
         where: { collectionId: collection.id, walletAddress: input.wallet },
      });
      const updated =
         removed.count > 0
            ? await tx.collection.update({
                 where: { id: collection.id },
                 data: { followerCount: { decrement: 1 } },
                 select: { followerCount: true },
              })
            : { followerCount: collection.followerCount };
      return { following: false, followerCount: updated.followerCount };
   });
}

/** Published collections the wallet follows, most recently followed first. */
export async function listFollowedCollections(wallet: string) {
   const follows = (await prisma.collectionFollow.findMany({
      where: { walletAddress: wallet, collection: { status: 'PUBLISHED' } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, collection: true },
   })) as Array<{ createdAt: Date; collection: CollectionRow }>;

   const ids = follows.map(f => f.collection.id);
   const items = ids.length
      ? ((await prisma.collectionItem.findMany({
           where: { collectionId: { in: ids } },
           select: { collectionId: true, keyId: true },
        })) as Array<{ collectionId: string; keyId: string }>)
      : [];
   const listable = await filterListableKeyIds(items.map(i => i.keyId));
   const counts = new Map<string, number>();
   for (const item of items) {
      if (!listable.has(item.keyId)) continue;
      counts.set(item.collectionId, (counts.get(item.collectionId) ?? 0) + 1);
   }

   return follows.map(f => ({
      ...toPublicSummary(f.collection, counts.get(f.collection.id) ?? 0),
      followedAt: f.createdAt,
   }));
}

/**
 * Items added to published collections the wallet follows, after it started
 * following, newest first. Feeds the derived notification list.
 */
export async function listFollowedCollectionItemAdds(
   wallet: string,
   limit: number
) {
   const follows = (await prisma.collectionFollow.findMany({
      where: { walletAddress: wallet },
      select: { collectionId: true, createdAt: true },
   })) as Array<{ collectionId: string; createdAt: Date }>;
   if (follows.length === 0) return [];

   // Filter by follow time in the query so the limit only counts real updates.
   const items = (await prisma.collectionItem.findMany({
      where: {
         OR: follows.map(f => ({
            collectionId: f.collectionId,
            createdAt: { gt: f.createdAt },
         })),
         collection: { status: 'PUBLISHED' },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
         keyId: true,
         note: true,
         createdAt: true,
         collectionId: true,
         collection: { select: { slug: true, title: true } },
      },
   })) as Array<{
      keyId: string;
      note: string | null;
      createdAt: Date;
      collectionId: string;
      collection: { slug: string; title: string };
   }>;

   const listable = await filterListableKeyIds(items.map(i => i.keyId));
   return items.filter(i => listable.has(i.keyId));
}
