// src/modules/regions/regions.integration.test.ts
// Database and HTTP lifecycle for jurisdiction rules (#1354).
//
//    RUN_REGIONS_INTEGRATION=1 DATABASE_URL=... pnpm test -- regions.integration
//
// Set GEOIP_TEST_DB to a MaxMind test database (GeoIP2-Country-Test.mmdb from
// github.com/maxmind/MaxMind-DB) to also exercise IP geolocation end to end.

import type { Express } from 'express';
import { randomUUID } from 'crypto';

// Must be set before config is first loaded.
process.env.TRUSTED_PROXIES = '127.0.0.1,::1';
if (process.env.GEOIP_TEST_DB) process.env.GEOIP_DB_PATH = process.env.GEOIP_TEST_DB;

const describeDatabase = process.env.RUN_REGIONS_INTEGRATION === '1' ? describe : describe.skip;
const itWithGeo = process.env.GEOIP_TEST_DB ? it : it.skip;

describeDatabase('region rules database and HTTP lifecycle', () => {
   const suffix = randomUUID().slice(0, 8);
   const trading = `itest_trading_${suffix}`;
   const lending = `itest_lending_${suffix}`;

   let app: Express;
   let prisma: typeof import('../../utils/prisma.utils').prisma;
   let request: typeof import('supertest');
   let asAdmin: Record<string, string>;

   beforeAll(() => {
      const express = require('express');
      const jwt = require('jsonwebtoken');
      request = require('supertest');
      ({ prisma } = require('../../utils/prisma.utils'));
      const { envConfig } = require('../../config');
      const { regionRulesAdminRouter, regionsRouter } = require('./regions.routes');
      const { regionGuard } = require('../../middlewares/region-guard.middleware');

      app = express();
      app.use(express.json());
      app.use('/v1/regions', regionsRouter);
      app.use('/v1/admin/regions/rules', regionRulesAdminRouter);
      app.get('/v1/trade', regionGuard(trading), (_req: unknown, res: { json: (b: unknown) => void }) =>
         res.json({ ok: true })
      );
      asAdmin = {
         Authorization: `Bearer ${jwt.sign({ sub: 'itest-admin', role: 'admin' }, envConfig.JWT_SECRET)}`,
      };
   });

   afterAll(async () => {
      await prisma.regionRule.deleteMany({ where: { feature: { in: [trading, lending] } } });
   });

   it('runs create, guard, me, update and delete against Postgres', async () => {
      const created = await request(app)
         .post('/v1/admin/regions/rules')
         .set(asAdmin)
         .send({ feature: trading, countryCode: 'us', reason: 'SECURITIES_RESTRICTION' });
      expect(created.status).toBe(201);
      const ruleId = created.body.data.rule.id;
      const stored = await prisma.regionRule.findUnique({ where: { id: ruleId } });
      expect(stored).toMatchObject({ countryCode: 'US', action: 'BLOCK' });

      const duplicate = await request(app)
         .post('/v1/admin/regions/rules')
         .set(asAdmin)
         .send({ feature: trading, countryCode: 'US', reason: 'SECURITIES_RESTRICTION' });
      expect(duplicate.status).toBe(409);

      const blocked = await request(app).get('/v1/trade').set('X-Declared-Country', 'us');
      expect(blocked.status).toBe(451);
      expect(blocked.body.error).toMatchObject({
         code: 'REGION_RESTRICTED',
         details: [{ field: 'reason', message: 'SECURITIES_RESTRICTION' }],
      });

      const allowed = await request(app).get('/v1/trade').set('X-Declared-Country', 'SE');
      expect(allowed.status).toBe(200);

      const me = await request(app).get('/v1/regions/me').set('X-Declared-Country', 'US');
      expect(me.status).toBe(200);
      expect(me.body.data.declaredCountry).toBe('US');
      expect(me.body.data.restrictedFeatures).toContainEqual({
         feature: trading,
         reason: 'SECURITIES_RESTRICTION',
      });

      // A rule change applies immediately on the instance that made it.
      const moved = await request(app)
         .patch(`/v1/admin/regions/rules/${ruleId}`)
         .set(asAdmin)
         .send({ countryCode: 'FR' });
      expect(moved.status).toBe(200);
      expect((await request(app).get('/v1/trade').set('X-Declared-Country', 'US')).status).toBe(200);
      expect((await request(app).get('/v1/trade').set('X-Declared-Country', 'FR')).status).toBe(451);

      const listed = await request(app).get('/v1/admin/regions/rules').set(asAdmin);
      expect(listed.body.data.rules.map((r: { id: string }) => r.id)).toContain(ruleId);

      expect((await request(app).delete(`/v1/admin/regions/rules/${ruleId}`).set(asAdmin)).status).toBe(204);
      expect((await request(app).delete(`/v1/admin/regions/rules/${ruleId}`).set(asAdmin)).status).toBe(404);
      expect((await request(app).get('/v1/trade').set('X-Declared-Country', 'FR')).status).toBe(200);
   });

   it('stores no IP address in the rules table', async () => {
      const columns: Array<{ column_name: string }> = await prisma.$queryRaw`
         SELECT column_name FROM information_schema.columns WHERE table_name = 'region_rules'`;
      expect(columns.map(c => c.column_name).sort()).toEqual(
         ['action', 'countryCode', 'createdAt', 'feature', 'id', 'reason', 'updatedAt'].sort()
      );
   });

   itWithGeo('geolocates the forwarded client behind a trusted proxy', async () => {
      const created = await request(app)
         .post('/v1/admin/regions/rules')
         .set(asAdmin)
         .send({ feature: lending, countryCode: 'GB', reason: 'LENDING_UNAVAILABLE' });
      expect(created.status).toBe(201);

      // supertest connects over loopback, which this test trusts as a proxy.
      const me = await request(app).get('/v1/regions/me').set('X-Forwarded-For', '81.2.69.160');
      expect(me.body.data.detectedCountry).toBe('GB');
      expect(me.body.data.restrictedFeatures).toContainEqual({
         feature: lending,
         reason: 'LENDING_UNAVAILABLE',
      });

      const sweden = await request(app).get('/v1/regions/me').set('X-Forwarded-For', '89.160.20.112');
      expect(sweden.body.data.detectedCountry).toBe('SE');
      expect(sweden.body.data.restrictedFeatures).not.toContainEqual(
         expect.objectContaining({ feature: lending })
      );
   });
});
