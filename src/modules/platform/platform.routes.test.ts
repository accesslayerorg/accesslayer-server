// src/modules/platform/platform.routes.test.ts

jest.mock('../../utils/redis.utils', () => ({
   cacheGet: jest.fn().mockResolvedValue(null),
   cacheGetJson: jest.fn().mockResolvedValue(null),
   cacheSetJson: jest.fn().mockResolvedValue(undefined),
   cacheSetRaw: jest.fn().mockResolvedValue(undefined),
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));

import express from 'express';
import request from 'supertest';
import platformRouter from './platform.routes';
import {
   clearPlatformPaused,
   resetPlatformPauseCache,
   setPlatformPaused,
} from './platform-pause.service';

const app = express();
app.use('/platform', platformRouter);

beforeEach(() => {
   resetPlatformPauseCache();
});

describe('GET /platform/status', () => {
   it('returns the paused state with timestamp and actor', async () => {
      await setPlatformPaused('GADMIN', new Date('2026-09-28T12:00:00.000Z'));

      const res = await request(app).get('/platform/status');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
         paused: true,
         pausedAt: '2026-09-28T12:00:00.000Z',
         actor: 'GADMIN',
      });
   });

   it('returns not paused after the cache is cleared', async () => {
      await setPlatformPaused('GADMIN');
      await clearPlatformPaused();

      const res = await request(app).get('/platform/status');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
         paused: false,
         pausedAt: null,
         actor: null,
      });
   });
});
