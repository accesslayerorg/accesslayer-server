import express from 'express';
import request from 'supertest';
import { errorCatalogRouter } from './error-catalog.routes';

// Exercises the committed error-catalog.json (validated in the service tests),
// so the routes are tested against the real data shape.
const app = express();
app.use(express.json());
app.use('/api/v1/errors', errorCatalogRouter);

describe('GET /errors/catalog', () => {
   it('returns the latest version for a contract with an ETag', async () => {
      const res = await request(app).get('/api/v1/errors/catalog').query({ contract: 'creator-keys' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.contract).toBe('creator-keys');
      expect(res.body.data.errors.length).toBe(res.body.data.errorCount);
      expect(res.headers.etag).toMatch(/^"[0-9a-f]{32}"$/);
   });

   it('returns 304 when If-None-Match matches the current ETag', async () => {
      const first = await request(app).get('/api/v1/errors/catalog').query({ contract: 'creator-keys' });
      const etag = first.headers.etag as string;
      const res = await request(app)
         .get('/api/v1/errors/catalog')
         .query({ contract: 'creator-keys' })
         .set('If-None-Match', etag);
      expect(res.status).toBe(304);
   });

   it('returns 404 for a contract that is not in the catalog', async () => {
      const res = await request(app).get('/api/v1/errors/catalog').query({ contract: 'no-such-contract' });
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
   });

   it('returns 400 when the contract parameter is missing', async () => {
      const res = await request(app).get('/api/v1/errors/catalog');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
   });
});

describe('POST /errors/decode', () => {
   it('decodes a raw Soroban failure into a catalog entry', async () => {
      const res = await request(app)
         .post('/api/v1/errors/decode')
         .send({ contract: 'creator-keys', raw: 'HostError: Error(Contract, #1)' });
      expect(res.status).toBe(200);
      expect(res.body.data.matched).toBe(true);
      expect(res.body.data.code).toBe(1);
      expect(res.body.data.error.enum).toEqual(expect.any(String));
   });

   it('returns the generic fallback when no contract is supplied', async () => {
      const res = await request(app).post('/api/v1/errors/decode').send({ code: 1 });
      expect(res.status).toBe(200);
      expect(res.body.data.matched).toBe(false);
      expect(res.body.data.fallback.message).toMatch(/does not describe/);
   });

   it('rejects a body with neither code nor raw', async () => {
      const res = await request(app).post('/api/v1/errors/decode').send({ contract: 'creator-keys' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
   });
});
