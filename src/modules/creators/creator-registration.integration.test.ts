import request from 'supertest';
import express from 'express';
import { prisma } from '../../utils/prisma.utils';

// Mock authentication middleware
const requireAuth = (req: any, res: any, next: any) => {
   if (!req.headers.authorization) {
      return res.status(401).json({ error: 'unauthenticated' });
   }
   req.user = { id: 'test-user-id' };
   next();
};

// Placeholder handler for the unmerged PR
const httpRegisterCreator = async (req: any, res: any) => {
   const { wallet, displayName } = req.body;

   try {
      const existing = await (prisma.creatorProfile.findFirst as any)({
         where: { handle: wallet },
      });

      if (existing) {
         return res.status(409).json({ error: 'creator_already_exists' });
      }

      const creator = await (prisma.creatorProfile.create as any)({
         data: {
            id: `creator-${Date.now()}`,
            handle: wallet,
            displayName: displayName || 'New Creator',
            userId: req.user.id,
         },
      });

      return res.status(201).json({ data: creator });
   } catch (_error) {
      return res.status(500).json({ error: 'internal_error' });
   }
};

const app = express();
app.use(express.json());
app.post('/api/v1/creators', requireAuth, httpRegisterCreator);

describe('Creator Registration Endpoint Integration (Placeholder)', () => {
   const wallet = 'GABC111111111111111111111111111111111111111111111111WXYZ';

   beforeAll(async () => {
      await (prisma.creatorProfile.deleteMany as any)({
         where: { handle: wallet },
      });
   });

   afterAll(async () => {
      await (prisma.creatorProfile.deleteMany as any)({
         where: { handle: wallet },
      });
   });

   it('returns 401 for unauthenticated requests', async () => {
      const response = await request(app)
         .post('/api/v1/creators')
         .send({ wallet, displayName: 'Test Creator' });

      expect(response.status).toBe(401);
   });

   it('creates a new creator profile and returns 201', async () => {
      const response = await request(app)
         .post('/api/v1/creators')
         .set('Authorization', 'Bearer token')
         .send({ wallet, displayName: 'Test Creator' });

      expect(response.status).toBe(201);
      expect(response.body.data).toHaveProperty('handle', wallet);
      expect(response.body.data).toHaveProperty('displayName', 'Test Creator');

      const dbRecord = await (prisma.creatorProfile.findFirst as any)({
         where: { handle: wallet },
      });
      expect(dbRecord).toBeTruthy();
   });

   it('returns 409 with creator_already_exists for duplicate wallet', async () => {
      const response = await request(app)
         .post('/api/v1/creators')
         .set('Authorization', 'Bearer token')
         .send({ wallet, displayName: 'Duplicate Creator' });

      expect(response.status).toBe(409);
      expect(response.body).toHaveProperty('error', 'creator_already_exists');
   });
});
