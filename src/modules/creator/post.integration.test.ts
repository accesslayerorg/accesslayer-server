import express from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-base';
import { buildAuthHeaders } from '../../utils/test/auth-request.utils';
import { requireStellarSignature } from '../../middlewares/stellar-signature.middleware';

const mockCreatorProfile = { findFirst: jest.fn(), findUnique: jest.fn() };
const mockCreatorPost = {
   create: jest.fn(),
   findMany: jest.fn(),
   findUnique: jest.fn(),
   delete: jest.fn(),
};
jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: mockCreatorProfile,
      creatorPost: mockCreatorPost,
   },
}));

import {
   httpCreatePost,
   httpListPosts,
   httpGetPost,
   httpDeletePost,
   postSchema,
} from './post.controller';
import { validateBody } from '../../middlewares/validate-body.middleware';

const app = express();
app.use(express.json());
app.post(
   '/api/v1/creators/:id/posts',
   requireStellarSignature(),
   validateBody(postSchema),
   httpCreatePost
);
app.get('/api/v1/creators/:id/posts', httpListPosts);
app.get('/api/v1/creators/:id/posts/:postId', httpGetPost);
app.delete(
   '/api/v1/creators/:id/posts/:postId',
   requireStellarSignature(),
   httpDeletePost
);

describe('creator post integration', () => {
   const wallet = Keypair.random();
   const creator = {
      id: 'creator-1',
      user: { stellarWallet: { address: wallet.publicKey() } },
   };
   const stored = {
      id: 'post-1',
      content: 'A first post',
      createdAt: new Date('2026-07-29T00:00:00Z'),
   };

   beforeEach(() => {
      jest.clearAllMocks();
      mockCreatorProfile.findFirst.mockResolvedValue(creator);
      mockCreatorProfile.findUnique.mockResolvedValue(creator);
      mockCreatorPost.create.mockResolvedValue(stored);
      mockCreatorPost.findMany.mockResolvedValue([stored]);
      mockCreatorPost.findUnique.mockResolvedValue({
         ...stored,
         creatorId: 'creator-1',
         creator,
      });
      mockCreatorPost.delete.mockResolvedValue(stored);
   });

   it('persists a post, returns required fields, and lists it', async () => {
      const body = { content: stored.content };
      const created = await request(app)
         .post('/api/v1/creators/creator-1/posts')
         .set(buildAuthHeaders(body, wallet))
         .send(body);

      expect(created.status).toBe(201);
      expect(created.body.data).toEqual(
         expect.objectContaining({
            id: 'post-1',
            content: stored.content,
            creator_wallet: wallet.publicKey(),
            created_at: stored.createdAt.toISOString(),
         })
      );
      expect(mockCreatorPost.create).toHaveBeenCalledWith(
         expect.objectContaining({
            data: { creatorId: 'creator-1', content: stored.content },
         })
      );

      const listed = await request(app).get('/api/v1/creators/creator-1/posts');
      expect(listed.body.data).toContainEqual(
         expect.objectContaining({ id: 'post-1' })
      );
   });

   it('rejects a wallet that is not registered as the creator', async () => {
      mockCreatorProfile.findFirst.mockResolvedValue(null);
      const body = { content: 'Not allowed' };
      const response = await request(app)
         .post('/api/v1/creators/creator-1/posts')
         .set(buildAuthHeaders(body, wallet))
         .send(body);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('not_a_creator');
   });

   it('rejects empty content with 422', async () => {
      const body = { content: '   ' };
      const response = await request(app)
         .post('/api/v1/creators/creator-1/posts')
         .set(buildAuthHeaders(body, wallet))
         .send(body);
      expect(response.status).toBe(422);
   });

   it('owner deletes post, returns 204, post no longer in list, and fetching returns 404', async () => {
      // 1. DELETE as creator A -> returns 204
      const response = await request(app)
         .delete('/api/v1/creators/creator-1/posts/post-1')
         .set(buildAuthHeaders({}, wallet))
         .send({});

      expect(response.status).toBe(204);
      expect(mockCreatorPost.delete).toHaveBeenCalledWith({
         where: { id: 'post-1' },
      });

      // 2. Post is absent from post list after deletion
      mockCreatorPost.findMany.mockResolvedValue([]);
      const listed = await request(app).get('/api/v1/creators/creator-1/posts');
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual([]);

      // 3. Deleted post cannot be fetched by ID (returns 404)
      mockCreatorPost.findUnique.mockResolvedValue(null);
      const getDeleted = await request(app).get(
         '/api/v1/creators/creator-1/posts/post-1'
      );
      expect(getDeleted.status).toBe(404);
      expect(getDeleted.body.error.code).toBe('NOT_FOUND');
   });

   it('rejects deletion by a non-owner with 403 forbidden', async () => {
      const nonOwnerWallet = Keypair.random();
      mockCreatorProfile.findFirst.mockResolvedValue(null);

      const response = await request(app)
         .delete('/api/v1/creators/creator-1/posts/post-1')
         .set(buildAuthHeaders({}, nonOwnerWallet))
         .send({});

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      expect(response.body.error.message.toLowerCase()).toContain('forbidden');
      expect(mockCreatorPost.delete).not.toHaveBeenCalled();
   });

   it('rejects unauthenticated delete request with 401', async () => {
      const response = await request(app).delete(
         '/api/v1/creators/creator-1/posts/post-1'
      );
      expect(response.status).toBe(401);
      expect(mockCreatorPost.delete).not.toHaveBeenCalled();
   });
});
