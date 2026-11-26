// src/modules/public-profiles/public-profile.routes.test.ts

import express from 'express';
import request from 'supertest';

jest.mock('../../middlewares/jwt-auth.middleware', () => ({
   requireJwtAuth: (req: any, _res: any, next: any) => {
      req.user = { wallet: 'GTOKENWALLET' };
      next();
   },
}));

jest.mock('./public-profile.service', () => {
   const actual = jest.requireActual('./public-profile.service');
   return {
      ...actual,
      getOwnPublicProfile: jest.fn(),
      getPublicProfileView: jest.fn(),
      upsertPublicProfile: jest.fn(),
   };
});

jest.mock('../../utils/logger.utils', () => ({
   logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { publicProfileMeRouter, publicProfilesRouter } from './public-profile.routes';
import {
   getOwnPublicProfile,
   getPublicProfileView,
   upsertPublicProfile,
   PublicProfileError,
} from './public-profile.service';

describe('public-profile.routes', () => {
   const app = express();
   app.use(express.json());
   app.use('/v1/me', publicProfileMeRouter);
   app.use('/v1/public', publicProfilesRouter);

   beforeEach(() => jest.clearAllMocks());

   it('GET /v1/public/profiles/:handle returns the filtered view', async () => {
      (getPublicProfileView as jest.Mock).mockResolvedValue({ handle: 'alice', keyCount: 2 });

      const res = await request(app).get('/v1/public/profiles/Alice');

      expect(res.status).toBe(200);
      expect(res.body.data.profile).toEqual({ handle: 'alice', keyCount: 2 });
      expect(getPublicProfileView).toHaveBeenCalledWith('Alice');
   });

   it('serves disabled and unknown handles with byte-identical 404 responses', async () => {
      // The service returns null for both; the route must not distinguish them.
      (getPublicProfileView as jest.Mock).mockResolvedValue(null);

      const disabled = await request(app).get('/v1/public/profiles/disabled_user');
      const unknown = await request(app).get('/v1/public/profiles/never_registered');

      expect(disabled.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(disabled.text).toBe(unknown.text);
      expect(disabled.headers['content-type']).toBe(unknown.headers['content-type']);
      expect(disabled.headers['content-length']).toBe(unknown.headers['content-length']);
   });

   it('PUT /v1/me/public-profile saves settings for the token wallet only', async () => {
      (upsertPublicProfile as jest.Mock).mockResolvedValue({ handle: 'alice', enabled: true });

      const res = await request(app)
         .put('/v1/me/public-profile')
         .send({ handle: 'alice', enabled: true, showPnl: true });

      expect(res.status).toBe(200);
      expect(upsertPublicProfile).toHaveBeenCalledWith('GTOKENWALLET', {
         handle: 'alice',
         enabled: true,
         showPnl: true,
      });
   });

   it('rejects unknown fields, so a wallet cannot be set through the body', async () => {
      const res = await request(app)
         .put('/v1/me/public-profile')
         .send({ handle: 'alice', wallet: 'GSOMEONEELSE' });

      expect(res.status).toBe(400);
      expect(upsertPublicProfile).not.toHaveBeenCalled();
   });

   it('rejects non-boolean flags and a missing handle', async () => {
      const badFlag = await request(app)
         .put('/v1/me/public-profile')
         .send({ handle: 'alice', enabled: 'yes' });
      const noHandle = await request(app).put('/v1/me/public-profile').send({ enabled: true });

      expect(badFlag.status).toBe(400);
      expect(noHandle.status).toBe(400);
      expect(upsertPublicProfile).not.toHaveBeenCalled();
   });

   it('maps service errors to their status, e.g. 409 for a taken handle', async () => {
      (upsertPublicProfile as jest.Mock).mockRejectedValue(
         new PublicProfileError(409, 'CONFLICT', 'This handle is already taken')
      );

      const res = await request(app).put('/v1/me/public-profile').send({ handle: 'taken' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
   });

   it('GET /v1/me/public-profile returns the owner settings or null', async () => {
      (getOwnPublicProfile as jest.Mock).mockResolvedValue(null);

      const res = await request(app).get('/v1/me/public-profile');

      expect(res.status).toBe(200);
      expect(res.body.data.profile).toBeNull();
      expect(getOwnPublicProfile).toHaveBeenCalledWith('GTOKENWALLET');
   });
});
