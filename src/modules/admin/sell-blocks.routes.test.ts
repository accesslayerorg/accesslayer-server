import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import adminRouter from './admin.routes';
import { envConfig } from '../../config';

jest.mock('./sell-blocks.service', () => ({
   getSellBlocks: jest.fn(),
   getSellBlocksSummary: jest.fn(),
}));

const app = express();
app.use('/api/v1/admin', adminRouter);

describe('sell-block admin route authorization', () => {
   it('returns 403 for an authenticated non-admin caller', async () => {
      const userToken = jwt.sign(
         { sub: 'user-1', role: 'user' },
         envConfig.JWT_SECRET,
         { expiresIn: 3600 }
      );

      const responses = await Promise.all([
         request(app)
            .get('/api/v1/admin/sell-blocks')
            .set('Authorization', `Bearer ${userToken}`),
         request(app)
            .get('/api/v1/admin/sell-blocks/summary')
            .set('Authorization', `Bearer ${userToken}`),
      ]);

      expect(responses.map(response => response.status)).toEqual([403, 403]);
   });
});
