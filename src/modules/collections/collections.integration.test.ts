// src/modules/collections/collections.integration.test.ts
// Database-backed lifecycle for curated collections (#1353). Runs against a
// real Postgres with RUN_COLLECTIONS_INTEGRATION=1 after `prisma db push`.

jest.unmock('@prisma/client');

import express from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-base';
import { prisma } from '../../utils/prisma.utils';
import { signWalletAccessToken } from '../../utils/jwt.utils';
import { collectionsRouter, followedCollectionsRouter } from './collections.routes';
import {
   COLLECTION_ITEM_ADDED_EVENT,
   listFollowedCollectionItemAdds,
} from './collections.service';

const suite = process.env.RUN_COLLECTIONS_INTEGRATION === '1' ? describe : describe.skip;

suite('curated collections lifecycle (database)', () => {
   const app = express();
   app.use(express.json());
   app.use('/api/v1/collections', collectionsRouter);
   app.use('/api/v1/me', followedCollectionsRouter);

   const prefix = 'coll-int';
   const slug = `${prefix}-stellar-picks`;
   const userId = `${prefix}-user`;
   const editor = Keypair.random().publicKey();
   const coEditor = Keypair.random().publicKey();
   const stranger = Keypair.random().publicKey();
   const fan = Keypair.random().publicKey();
   const bearer = (wallet: string) => ({
      Authorization: `Bearer ${signWalletAccessToken(wallet)}`,
   });
   const key = (name: string) => `${prefix}-${name}`;

   async function eventsForCollection(collectionId: string) {
      const rows = await prisma.outboxEvent.findMany({
         where: { type: COLLECTION_ITEM_ADDED_EVENT },
         select: { payload: true },
      });
      return rows
         .map(row =>
            typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
         )
         .filter((payload: { collectionId?: string }) => payload.collectionId === collectionId);
   }

   async function cleanup() {
      await prisma.collection.deleteMany({ where: { slug: { startsWith: prefix } } });
      await prisma.keyReport.deleteMany({ where: { keyId: { startsWith: prefix } } });
      await prisma.keyFreeze.deleteMany({ where: { keyId: { startsWith: prefix } } });
      await prisma.creatorProfile.deleteMany({ where: { id: { startsWith: prefix } } });
      await prisma.user.deleteMany({ where: { id: userId } });
   }

   beforeAll(async () => {
      await cleanup();
      await prisma.user.create({
         data: {
            id: userId,
            email: `${prefix}@example.com`,
            passwordHash: 'dummy-hash',
            firstName: 'Collections',
            lastName: 'Integration',
         },
      });
      const profile = (name: string, extra: Record<string, unknown> = {}) =>
         prisma.creatorProfile.create({
            data: { id: key(name), userId, handle: key(name), displayName: name, ...extra },
         });
      await profile('active-1');
      await profile('active-2');
      await profile('active-3');
      await profile('active-4');
      await profile('retired', { status: 'Retired', deprecatedAt: new Date() });
      await profile('sunset', { sunsetFlaggedAt: new Date() });
      await profile('frozen');
      await profile('flagged');
      await profile('thawed');
      await prisma.keyFreeze.createMany({
         data: [
            { keyId: key('frozen'), isFrozen: true },
            // An expired freeze no longer hides the key.
            { keyId: key('thawed'), isFrozen: true, expiryTimestamp: new Date('2026-01-01T00:00:00Z') },
         ],
      });
      await prisma.keyReport.create({
         data: { keyId: key('flagged'), reporter: stranger, reason: 'scam', status: 'actioned' },
      });
   });

   afterAll(async () => {
      await cleanup();
   });

   let collectionId: string;

   it('creates a draft that stays out of every public view', async () => {
      const created = await request(app)
         .post('/api/v1/collections')
         .set(bearer(editor))
         .send({ slug, title: 'Stellar picks', description: 'Hand-picked keys' });
      expect(created.status).toBe(201);
      expect(created.body.data.collection.status).toBe('DRAFT');
      expect(created.body.data.collection.editorWallets).toEqual([editor]);
      collectionId = created.body.data.collection.id;

      const duplicate = await request(app)
         .post('/api/v1/collections')
         .set(bearer(stranger))
         .send({ slug, title: 'Copycat' });
      expect(duplicate.status).toBe(409);

      const list = await request(app).get('/api/v1/collections?limit=50');
      expect(list.body.data.map((c: { slug: string }) => c.slug)).not.toContain(slug);
      expect((await request(app).get(`/api/v1/collections/${slug}`)).status).toBe(404);
      expect(
         (await request(app).post(`/api/v1/collections/${slug}/follow`).set(bearer(fan))).status
      ).toBe(404);
   });

   it('lets only editors add items, assigning unique positions and one event per add', async () => {
      const forbidden = await request(app)
         .post(`/api/v1/collections/${slug}/items`)
         .set(bearer(stranger))
         .send({ keyId: key('active-1') });
      expect(forbidden.status).toBe(403);

      const names = ['active-1', 'retired', 'active-2', 'frozen', 'flagged', 'sunset', 'thawed'];
      for (const name of names) {
         const res = await request(app)
            .post(`/api/v1/collections/${slug}/items`)
            .set(bearer(editor))
            .send({ keyId: key(name), note: `note ${name}` });
         expect(res.status).toBe(201);
      }

      // Concurrent adds serialize on the collection row lock.
      const [a, b] = await Promise.all([
         request(app)
            .post(`/api/v1/collections/${slug}/items`)
            .set(bearer(editor))
            .send({ keyId: key('active-3') }),
         request(app)
            .post(`/api/v1/collections/${slug}/items`)
            .set(bearer(editor))
            .send({ keyId: key('active-4') }),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);

      const duplicate = await request(app)
         .post(`/api/v1/collections/${slug}/items`)
         .set(bearer(editor))
         .send({ keyId: key('active-1') });
      expect(duplicate.status).toBe(409);

      const rows = await prisma.collectionItem.findMany({
         where: { collectionId },
         orderBy: { position: 'asc' },
      });
      expect(rows.map(r => r.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      expect((await eventsForCollection(collectionId)).length).toBe(9);
   });

   it('publishes and hides frozen, retired, sunset and flagged keys publicly', async () => {
      const publish = await request(app)
         .patch(`/api/v1/collections/${slug}`)
         .set(bearer(editor))
         .send({ status: 'PUBLISHED', editorWallets: [editor, coEditor] });
      expect(publish.status).toBe(200);
      expect(publish.body.data.collection.publishedAt).toBeTruthy();

      const detail = await request(app).get(`/api/v1/collections/${slug}`);
      expect(detail.status).toBe(200);
      const visible = detail.body.data.collection.items.map((i: { keyId: string }) => i.keyId);
      expect(visible.slice(0, 3)).toEqual([key('active-1'), key('active-2'), key('thawed')]);
      // The two concurrent adds take positions 7 and 8 in either order.
      expect([...visible.slice(3)].sort()).toEqual([key('active-3'), key('active-4')]);
      expect(detail.body.data.collection.items[0].note).toBe('note active-1');
      expect(detail.body.data.collection.itemCount).toBe(5);
      expect(detail.body.data.collection).not.toHaveProperty('editorWallets');

      const list = await request(app).get('/api/v1/collections?limit=50');
      const summary = list.body.data.find((c: { slug: string }) => c.slug === slug);
      expect(summary).toEqual(expect.objectContaining({ itemCount: 5, followerCount: 0 }));
   });

   it('reorders with unique positions and lets a co-editor manage items', async () => {
      const current = await prisma.collectionItem.findMany({
         where: { collectionId },
         orderBy: { position: 'asc' },
         select: { keyId: true },
      });
      const reversed = current.map(r => r.keyId).reverse();

      const bad = await request(app)
         .put(`/api/v1/collections/${slug}/items/order`)
         .set(bearer(editor))
         .send({ orderedKeyIds: reversed.slice(1) });
      expect(bad.status).toBe(400);

      const res = await request(app)
         .put(`/api/v1/collections/${slug}/items/order`)
         .set(bearer(coEditor))
         .send({ orderedKeyIds: reversed });
      expect(res.status).toBe(200);

      const rows = await prisma.collectionItem.findMany({
         where: { collectionId },
         orderBy: { position: 'asc' },
      });
      expect(rows.map(r => r.keyId)).toEqual(reversed);
      expect(rows.map(r => r.position)).toEqual(reversed.map((_, i) => i));

      const removed = await request(app)
         .delete(`/api/v1/collections/${slug}/items/${key('retired')}`)
         .set(bearer(coEditor));
      expect(removed.status).toBe(204);
      expect(
         (
            await request(app)
               .delete(`/api/v1/collections/${slug}/items/${key('retired')}`)
               .set(bearer(coEditor))
         ).status
      ).toBe(404);
   });

   it('follows once, tracks the count, and feeds later additions to followers', async () => {
      for (let i = 0; i < 2; i++) {
         const res = await request(app)
            .post(`/api/v1/collections/${slug}/follow`)
            .set(bearer(fan));
         expect(res.status).toBe(200);
         expect(res.body.data).toEqual({ following: true, followerCount: 1 });
      }
      expect(
         await prisma.collectionFollow.count({ where: { collectionId, walletAddress: fan } })
      ).toBe(1);

      const followed = await request(app).get('/api/v1/me/followed-collections').set(bearer(fan));
      expect(followed.status).toBe(200);
      expect(followed.body.data.collections.map((c: { slug: string }) => c.slug)).toEqual([slug]);

      // Additions before the follow are not news; a new one after it is.
      await new Promise(resolve => setTimeout(resolve, 20));
      await request(app)
         .post(`/api/v1/collections/${slug}/items`)
         .set(bearer(editor))
         .send({ keyId: key('retired'), note: 'back again' });
      expect(await listFollowedCollectionItemAdds(fan, 50)).toEqual([]);

      await prisma.creatorProfile.update({
         where: { id: key('retired') },
         data: { status: 'Active', deprecatedAt: null },
      });
      const adds = await listFollowedCollectionItemAdds(fan, 50);
      expect(adds.map(a => [a.collection.slug, a.keyId, a.note])).toEqual([
         [slug, key('retired'), 'back again'],
      ]);

      for (let i = 0; i < 2; i++) {
         const res = await request(app)
            .delete(`/api/v1/collections/${slug}/follow`)
            .set(bearer(fan));
         expect(res.body.data).toEqual({ following: false, followerCount: 0 });
      }
   });
});
