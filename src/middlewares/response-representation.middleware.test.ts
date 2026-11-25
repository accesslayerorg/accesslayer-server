import express from 'express';
import request from 'supertest';
import {
   isCompressibleContentType,
   negotiateEncoding,
   responseCachePolicyMiddleware,
   responseCompressionMiddleware,
} from './response-representation.middleware';

const LARGE_LIST = {
   items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `creator-${i}` })),
};

function buildApp() {
   const app = express();
   app.use(responseCachePolicyMiddleware);
   app.use(responseCompressionMiddleware);

   app.get('/list', (_req, res) => {
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json(LARGE_LIST);
   });
   app.get('/small', (_req, res) => {
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({ ok: true });
   });
   app.get('/v1/profile', (_req, res) => {
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json(LARGE_LIST);
   });
   app.get('/api/v1/admin/audit', (_req, res) => {
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.json(LARGE_LIST);
   });
   return app;
}

describe('negotiateEncoding', () => {
   it('prefers br when weighted at least as high as gzip', () => {
      expect(negotiateEncoding('gzip, br')).toBe('br');
      expect(negotiateEncoding('br;q=0.8, gzip;q=0.8')).toBe('br');
   });

   it('falls back to gzip when br is not preferred', () => {
      expect(negotiateEncoding('gzip;q=0.5, br;q=0.4')).toBe('gzip');
   });

   it('returns null for absent or refused encodings', () => {
      expect(negotiateEncoding(undefined)).toBeNull();
      expect(negotiateEncoding('identity')).toBeNull();
      expect(negotiateEncoding('br;q=0, gzip;q=0')).toBeNull();
   });

   it('honours the wildcard', () => {
      expect(negotiateEncoding('*')).toBe('br');
   });
});

describe('isCompressibleContentType', () => {
   it('allows text, JSON and SVG and rejects binary types', () => {
      expect(isCompressibleContentType('application/json; charset=utf-8')).toBe(true);
      expect(isCompressibleContentType('text/csv')).toBe(true);
      expect(isCompressibleContentType('application/problem+json')).toBe(true);
      expect(isCompressibleContentType('image/svg+xml')).toBe(true);
      expect(isCompressibleContentType('image/png')).toBe(false);
      expect(isCompressibleContentType('application/pdf')).toBe(false);
      expect(isCompressibleContentType(undefined)).toBe(false);
   });
});

describe('responseCompressionMiddleware', () => {
   it('gzips large JSON bodies when the client accepts gzip', async () => {
      const res = await request(buildApp())
         .get('/list')
         .set('Accept-Encoding', 'gzip');

      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBe('gzip');
      expect(res.headers.vary).toContain('Accept-Encoding');
      expect(res.body.items).toHaveLength(200);
   });

   it('uses brotli when offered and preferred', async () => {
      const res = await request(buildApp())
         .get('/list')
         .set('Accept-Encoding', 'br, gzip');

      expect(res.headers['content-encoding']).toBe('br');
   });

   it('leaves small bodies uncompressed', async () => {
      const res = await request(buildApp())
         .get('/small')
         .set('Accept-Encoding', 'gzip');

      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.body).toEqual({ ok: true });
   });

   it('does not compress when the client sends no Accept-Encoding', async () => {
      const res = await request(buildApp())
         .get('/list')
         .set('Accept-Encoding', 'identity');

      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.body.items).toHaveLength(200);
   });

   it('answers a matching If-None-Match with 304 and no body', async () => {
      const app = buildApp();
      const first = await request(app).get('/small');
      const etag = first.headers.etag;
      expect(etag).toBeDefined();

      const second = await request(app)
         .get('/small')
         .set('If-None-Match', etag);

      expect(second.status).toBe(304);
      expect(second.text ?? '').toBe('');
   });
});

describe('responseCachePolicyMiddleware', () => {
   it('forces no-store on admin routes even when a route asks for public caching', async () => {
      const res = await request(buildApp()).get('/api/v1/admin/audit');

      expect(res.headers['cache-control']).toBe('no-store');
   });

   it('rewrites public caching to private for authenticated requests', async () => {
      const res = await request(buildApp())
         .get('/v1/profile')
         .set('Authorization', 'Bearer test-token');

      expect(res.headers['cache-control']).toBe('private, max-age=300');
      expect(res.headers.vary).toContain('Authorization');
   });

   it('keeps public caching for anonymous requests', async () => {
      const res = await request(buildApp()).get('/v1/profile');

      expect(res.headers['cache-control']).toBe('public, max-age=300');
   });
});
