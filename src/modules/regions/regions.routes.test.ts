// src/modules/regions/regions.routes.test.ts

jest.mock('../../utils/logger.utils', () => ({
   logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('./regions.service', () => {
   const actual = jest.requireActual('./regions.service');
   return {
      ...actual,
      resolveRegionContext: jest.fn(),
      getActiveRegionRules: jest.fn(),
      listRegionRules: jest.fn(),
      createRegionRule: jest.fn(),
      updateRegionRule: jest.fn(),
      deleteRegionRule: jest.fn(),
   };
});

import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { envConfig } from '../../config';
import { regionRulesAdminRouter, regionsRouter } from './regions.routes';
import {
   createRegionRule,
   deleteRegionRule,
   getActiveRegionRules,
   listRegionRules,
   RegionServiceError,
   resolveRegionContext,
   updateRegionRule,
} from './regions.service';

const app = express();
app.use(express.json());
app.use('/v1/regions', regionsRouter);
app.use('/v1/admin/regions/rules', regionRulesAdminRouter);

const adminToken = jwt.sign({ sub: 'admin-1', role: 'admin' }, envConfig.JWT_SECRET);
const userToken = jwt.sign({ sub: 'user-1', role: 'user' }, envConfig.JWT_SECRET);
const asAdmin = { Authorization: `Bearer ${adminToken}` };

describe('GET /v1/regions/me', () => {
   it('returns detected and declared countries with the restricted features', async () => {
      (resolveRegionContext as jest.Mock).mockResolvedValue({
         detectedCountry: 'GB',
         declaredCountry: 'US',
         ipHash: 'abc',
      });
      (getActiveRegionRules as jest.Mock).mockResolvedValue([
         { feature: 'key_trading', countryCode: 'US', reason: 'SECURITIES_RESTRICTION' },
         { feature: 'lending', countryCode: 'GB', reason: 'LENDING_UNAVAILABLE' },
         { feature: 'staking', countryCode: 'FR', reason: 'STAKING_UNAVAILABLE' },
      ]);

      const res = await request(app).get('/v1/regions/me');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.body.data).toEqual({
         detectedCountry: 'GB',
         declaredCountry: 'US',
         restrictedFeatures: [
            { feature: 'key_trading', reason: 'SECURITIES_RESTRICTION' },
            { feature: 'lending', reason: 'LENDING_UNAVAILABLE' },
         ],
      });
      expect(JSON.stringify(res.body)).not.toContain('ipHash');
   });

   it('returns 400 for an invalid declared country', async () => {
      (resolveRegionContext as jest.Mock).mockRejectedValue(
         new RegionServiceError(400, 'VALIDATION_ERROR', 'bad country')
      );
      const res = await request(app).get('/v1/regions/me');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
   });
});

describe('admin region rules', () => {
   beforeEach(() => jest.clearAllMocks());

   it('requires an admin token', async () => {
      expect((await request(app).get('/v1/admin/regions/rules')).status).toBe(401);
      const res = await request(app)
         .post('/v1/admin/regions/rules')
         .set({ Authorization: `Bearer ${userToken}` })
         .send({ feature: 'key_trading', countryCode: 'US', reason: 'SECURITIES_RESTRICTION' });
      expect(res.status).toBe(403);
      expect(createRegionRule).not.toHaveBeenCalled();
   });

   it('lists rules', async () => {
      (listRegionRules as jest.Mock).mockResolvedValue([{ id: 'r1' }]);
      const res = await request(app).get('/v1/admin/regions/rules').set(asAdmin);
      expect(res.status).toBe(200);
      expect(res.body.data.rules).toEqual([{ id: 'r1' }]);
   });

   it('creates a rule with a normalized country code', async () => {
      (createRegionRule as jest.Mock).mockResolvedValue({ id: 'r1' });
      const res = await request(app)
         .post('/v1/admin/regions/rules')
         .set(asAdmin)
         .send({ feature: 'key_trading', countryCode: 'us', reason: 'SECURITIES_RESTRICTION' });
      expect(res.status).toBe(201);
      expect(createRegionRule).toHaveBeenCalledWith({
         feature: 'key_trading',
         countryCode: 'US',
         reason: 'SECURITIES_RESTRICTION',
      });
   });

   it.each([
      [{ feature: 'Key Trading', countryCode: 'US', reason: 'SECURITIES_RESTRICTION' }, 'feature'],
      [{ feature: 'key_trading', countryCode: 'USA', reason: 'SECURITIES_RESTRICTION' }, 'countryCode'],
      [{ feature: 'key_trading', countryCode: 'US', reason: 'not allowed in the US' }, 'reason'],
   ])('rejects an invalid rule %#', async (body, field) => {
      const res = await request(app).post('/v1/admin/regions/rules').set(asAdmin).send(body);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.error.details)).toContain(field);
      expect(createRegionRule).not.toHaveBeenCalled();
   });

   it('passes service conflicts through as 409', async () => {
      (createRegionRule as jest.Mock).mockRejectedValue(
         new RegionServiceError(409, 'CONFLICT', 'exists')
      );
      const res = await request(app)
         .post('/v1/admin/regions/rules')
         .set(asAdmin)
         .send({ feature: 'key_trading', countryCode: 'US', reason: 'SECURITIES_RESTRICTION' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
   });

   it('updates and deletes rules', async () => {
      (updateRegionRule as jest.Mock).mockResolvedValue({ id: 'r1', reason: 'OTHER_REASON' });
      const patch = await request(app)
         .patch('/v1/admin/regions/rules/r1')
         .set(asAdmin)
         .send({ reason: 'OTHER_REASON' });
      expect(patch.status).toBe(200);
      expect(updateRegionRule).toHaveBeenCalledWith('r1', { reason: 'OTHER_REASON' });

      const emptyPatch = await request(app).patch('/v1/admin/regions/rules/r1').set(asAdmin).send({});
      expect(emptyPatch.status).toBe(400);

      (deleteRegionRule as jest.Mock).mockResolvedValue(undefined);
      const del = await request(app).delete('/v1/admin/regions/rules/r1').set(asAdmin);
      expect(del.status).toBe(204);
      expect(deleteRegionRule).toHaveBeenCalledWith('r1');
   });
});
