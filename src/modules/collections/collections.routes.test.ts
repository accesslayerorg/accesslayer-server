// src/modules/collections/collections.routes.test.ts

import express from 'express';
import request from 'supertest';

jest.mock('../../middlewares/jwt-auth.middleware', () => ({
   requireJwtAuth: (req: any, res: any, next: any) => {
      if (!req.headers.authorization) {
         res.status(401).json({ success: false });
         return;
      }
      req.user = { wallet: 'GEDITOR' };
      next();
   },
}));

jest.mock('./collections.service', () => {
   const actual = jest.requireActual('./collections.service');
   return {
      ...actual,
      listPublishedCollections: jest.fn(),
      getPublishedCollectionWithItems: jest.fn(),
      createCollection: jest.fn(),
      updateCollection: jest.fn(),
      addCollectionItem: jest.fn(),
      removeCollectionItem: jest.fn(),
      reorderCollectionItems: jest.fn(),
      followCollection: jest.fn(),
      unfollowCollection: jest.fn(),
      listFollowedCollections: jest.fn(),
   };
});

jest.mock('../../utils/logger.utils', () => ({
   logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { collectionsRouter, followedCollectionsRouter } from './collections.routes';
import {
   CollectionServiceError,
   addCollectionItem,
   createCollection,
   followCollection,
   getPublishedCollectionWithItems,
   listFollowedCollections,
   listPublishedCollections,
   removeCollectionItem,
   reorderCollectionItems,
   updateCollection,
} from './collections.service';

const AUTH = { Authorization: 'Bearer token' };

describe('collections.routes', () => {
   const app = express();
   app.use(express.json());
   app.use('/v1/collections', collectionsRouter);
   app.use('/v1/me', followedCollectionsRouter);

   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('GET /v1/collections returns a paginated published list', async () => {
      const meta = {
         page: 2,
         limit: 5,
         totalCount: 6,
         totalPages: 2,
         hasNextPage: false,
         hasPrevPage: true,
      };
      (listPublishedCollections as jest.Mock).mockResolvedValue({
         data: [{ slug: 'stellar-picks', itemCount: 2 }],
         meta,
      });

      const res = await request(app).get('/v1/collections?page=2&limit=5');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([{ slug: 'stellar-picks', itemCount: 2 }]);
      expect(res.body.meta).toEqual(meta);
      expect(listPublishedCollections).toHaveBeenCalledWith({ page: 2, limit: 5 });
   });

   it('GET /v1/collections rejects an out-of-range limit', async () => {
      const res = await request(app).get('/v1/collections?limit=500');
      expect(res.status).toBe(400);
      expect(listPublishedCollections).not.toHaveBeenCalled();
   });

   it('GET /v1/collections/:slug returns the collection and maps 404', async () => {
      (getPublishedCollectionWithItems as jest.Mock).mockResolvedValueOnce({
         slug: 'stellar-picks',
         items: [{ keyId: 'k1', position: 0, note: 'Top pick' }],
      });
      const ok = await request(app).get('/v1/collections/stellar-picks');
      expect(ok.status).toBe(200);
      expect(ok.body.data.collection.items[0].note).toBe('Top pick');

      (getPublishedCollectionWithItems as jest.Mock).mockRejectedValueOnce(
         new CollectionServiceError(404, 'NOT_FOUND', 'Collection not found')
      );
      const missing = await request(app).get('/v1/collections/draft-one');
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('NOT_FOUND');
   });

   it('rejects a malformed slug before reaching the service', async () => {
      const res = await request(app).get('/v1/collections/Not_A_Slug!');
      expect(res.status).toBe(400);
      expect(getPublishedCollectionWithItems).not.toHaveBeenCalled();
   });

   it('POST /v1/collections requires auth and creates a draft', async () => {
      const unauthenticated = await request(app)
         .post('/v1/collections')
         .send({ slug: 'stellar-picks', title: 'Stellar picks' });
      expect(unauthenticated.status).toBe(401);

      (createCollection as jest.Mock).mockResolvedValue({ slug: 'stellar-picks', status: 'DRAFT' });
      const res = await request(app)
         .post('/v1/collections')
         .set(AUTH)
         .send({ slug: 'Stellar-Picks', title: 'Stellar picks' });
      expect(res.status).toBe(201);
      expect(createCollection).toHaveBeenCalledWith({
         wallet: 'GEDITOR',
         slug: 'stellar-picks',
         title: 'Stellar picks',
      });
   });

   it('PATCH /v1/collections/:slug validates editor wallets and status', async () => {
      const bad = await request(app)
         .patch('/v1/collections/stellar-picks')
         .set(AUTH)
         .send({ editorWallets: ['not-a-wallet'] });
      expect(bad.status).toBe(400);

      const empty = await request(app).patch('/v1/collections/stellar-picks').set(AUTH).send({});
      expect(empty.status).toBe(400);

      (updateCollection as jest.Mock).mockResolvedValue({ slug: 'stellar-picks', status: 'PUBLISHED' });
      const ok = await request(app)
         .patch('/v1/collections/stellar-picks')
         .set(AUTH)
         .send({ status: 'PUBLISHED' });
      expect(ok.status).toBe(200);
      expect(updateCollection).toHaveBeenCalledWith({
         wallet: 'GEDITOR',
         slug: 'stellar-picks',
         status: 'PUBLISHED',
      });
   });

   it('maps a non-editor write to 403', async () => {
      (addCollectionItem as jest.Mock).mockRejectedValue(
         new CollectionServiceError(403, 'FORBIDDEN', 'Only collection editors can change this collection')
      );
      const res = await request(app)
         .post('/v1/collections/stellar-picks/items')
         .set(AUTH)
         .send({ keyId: 'k1' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
   });

   it('POST /:slug/items adds an item', async () => {
      (addCollectionItem as jest.Mock).mockResolvedValue({ keyId: 'k1', position: 0, note: 'Top' });
      const res = await request(app)
         .post('/v1/collections/stellar-picks/items')
         .set(AUTH)
         .send({ keyId: 'k1', note: 'Top' });
      expect(res.status).toBe(201);
      expect(res.body.data.item.position).toBe(0);
   });

   it('PUT /:slug/items/order forwards the order and maps a 400', async () => {
      (reorderCollectionItems as jest.Mock).mockResolvedValueOnce([
         { keyId: 'b', position: 0 },
         { keyId: 'a', position: 1 },
      ]);
      const ok = await request(app)
         .put('/v1/collections/stellar-picks/items/order')
         .set(AUTH)
         .send({ orderedKeyIds: ['b', 'a'] });
      expect(ok.status).toBe(200);
      expect(ok.body.data.items.map((i: any) => i.position)).toEqual([0, 1]);

      const invalid = await request(app)
         .put('/v1/collections/stellar-picks/items/order')
         .set(AUTH)
         .send({ orderedKeyIds: [] });
      expect(invalid.status).toBe(400);
   });

   it('DELETE /:slug/items/:keyId returns 204', async () => {
      (removeCollectionItem as jest.Mock).mockResolvedValue(undefined);
      const res = await request(app).delete('/v1/collections/stellar-picks/items/k1').set(AUTH);
      expect(res.status).toBe(204);
      expect(removeCollectionItem).toHaveBeenCalledWith({
         wallet: 'GEDITOR',
         slug: 'stellar-picks',
         keyId: 'k1',
      });
   });

   it('POST /:slug/follow returns the follow state', async () => {
      (followCollection as jest.Mock).mockResolvedValue({ following: true, followerCount: 4 });
      const res = await request(app).post('/v1/collections/stellar-picks/follow').set(AUTH);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ following: true, followerCount: 4 });
   });

   it('GET /v1/me/followed-collections lists the caller follows', async () => {
      (listFollowedCollections as jest.Mock).mockResolvedValue([{ slug: 'stellar-picks' }]);
      const res = await request(app).get('/v1/me/followed-collections').set(AUTH);
      expect(res.status).toBe(200);
      expect(res.body.data.collections).toEqual([{ slug: 'stellar-picks' }]);
      expect(listFollowedCollections).toHaveBeenCalledWith('GEDITOR');
   });

   it('returns 500 with a generic message for unexpected errors', async () => {
      (listPublishedCollections as jest.Mock).mockRejectedValue(new Error('db down'));
      const res = await request(app).get('/v1/collections');
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
   });
});
