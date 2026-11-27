// src/modules/roadmap/roadmap.routes.test.ts

import express from 'express';
import request from 'supertest';

jest.mock('../../middlewares/jwt-auth.middleware', () => ({
   requireJwtAuth: (req: any, _res: any, next: any) => {
      req.user = { wallet: 'GWALLET_HOLDER' };
      next();
   },
   requireKeyCreator: () => (req: any, _res: any, next: any) => {
      req.user = { wallet: 'GWALLET_CREATOR' };
      next();
   },
}));

jest.mock('./roadmap.service', () => {
   const actual = jest.requireActual('./roadmap.service');
   return {
      ...actual,
      getKeyRoadmap: jest.fn(),
      createRoadmapMilestone: jest.fn(),
      updateRoadmapMilestone: jest.fn(),
      reorderRoadmapMilestones: jest.fn(),
      addMilestoneReaction: jest.fn(),
   };
});

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

import { keyRoadmapRouter, milestoneReactionsRouter } from './roadmap.routes';
import {
   getKeyRoadmap,
   createRoadmapMilestone,
   reorderRoadmapMilestones,
   addMilestoneReaction,
} from './roadmap.service';

describe('roadmap.routes', () => {
   const app = express();
   app.use(express.json());
   app.use('/v1/keys', keyRoadmapRouter);
   app.use('/v1/milestones', milestoneReactionsRouter);

   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('GET /v1/keys/:keyId/roadmap returns milestones', async () => {
      (getKeyRoadmap as jest.Mock).mockResolvedValue([
         { id: 'm1', title: 'Launch', position: 0, reactionCounts: { total: 2, byType: { rocket: 2 } } },
      ]);

      const res = await request(app).get('/v1/keys/key-1/roadmap');
      expect(res.status).toBe(200);
      expect(res.body.data.milestones).toHaveLength(1);
   });

   it('POST /v1/keys/:keyId/roadmap creates milestone', async () => {
      (createRoadmapMilestone as jest.Mock).mockResolvedValue({
         id: 'm1',
         title: 'Launch',
         status: 'PLANNED',
      });

      const res = await request(app)
         .post('/v1/keys/key-1/roadmap')
         .send({ title: 'Launch' });

      expect(res.status).toBe(201);
      expect(res.body.data.milestone.id).toBe('m1');
   });

   it('PUT /v1/keys/:keyId/roadmap/order reorders milestones', async () => {
      (reorderRoadmapMilestones as jest.Mock).mockResolvedValue([
         { id: 'm2', position: 0 },
         { id: 'm1', position: 1 },
      ]);

      const res = await request(app)
         .put('/v1/keys/key-1/roadmap/order')
         .send({ orderedIds: ['m2', 'm1'] });

      expect(res.status).toBe(200);
      expect(res.body.data.milestones).toHaveLength(2);
   });

   it('POST /v1/milestones/:id/reactions creates reaction', async () => {
      (addMilestoneReaction as jest.Mock).mockResolvedValue({
         id: 'r1',
         milestoneId: 'm1',
         reaction: 'rocket',
      });

      const res = await request(app)
         .post('/v1/milestones/m1/reactions')
         .send({ reaction: 'rocket' });

      expect(res.status).toBe(201);
      expect(res.body.data.reaction.reaction).toBe('rocket');
   });
});
