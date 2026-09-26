import supertest from 'supertest';

/**
 * Configures a deliberately tiny limit for the 'auth' group before the app
 * (and its config) is loaded, so the test can send a real oversized payload
 * and observe the actual 413 response — not just call the middleware
 * function directly. jest.resetModules() + a fresh require() is necessary
 * here because config.ts parses process.env once, at import time.
 */
function loadAppWithAuthLimit(limit: string) {
   jest.resetModules();
   process.env.BODY_SIZE_LIMIT_AUTH = limit;

   return require('../../app').default;
}

describe('request body size limits (route-group scoped)', () => {
   const ORIGINAL_AUTH_LIMIT = process.env.BODY_SIZE_LIMIT_AUTH;

   afterEach(() => {
      if (ORIGINAL_AUTH_LIMIT === undefined) {
         delete process.env.BODY_SIZE_LIMIT_AUTH;
      } else {
         process.env.BODY_SIZE_LIMIT_AUTH = ORIGINAL_AUTH_LIMIT;
      }
   });

   it("rejects a request exceeding the auth group's configured limit with a clean 413", async () => {
      const app = loadAppWithAuthLimit('1kb');

      // A payload comfortably over 1kb.
      const oversizedPayload = { data: 'x'.repeat(5000) };

      const res = await supertest(app)
         .post('/api/v1/auth/login')
         .send(oversizedPayload);

      expect(res.status).toBe(413);
      expect(res.body).toEqual({
         success: false,
         code: 'BAD_REQUEST',
         message: 'Request payload too large',
      });
   });

   it("accepts a request within the auth group's configured limit (does not reject on size)", async () => {
      const app = loadAppWithAuthLimit('1kb');

      const smallPayload = { email: 'user@example.com', password: 'x' };

      const res = await supertest(app)
         .post('/api/v1/auth/login')
         .send(smallPayload);

      // Whatever the auth handler does with these credentials (likely a 400
      // or 401 for a nonexistent user) is out of scope here — the only thing
      // this test asserts is that the request was NOT rejected for size.
      expect(res.status).not.toBe(413);
   });

   it('does not reject a differently-sized payload on an unrelated group sharing the default limit', async () => {
      const app = loadAppWithAuthLimit('1kb');

      // /api/v1/health is in the 'default' group, unaffected by the 'auth'
      // group's tiny override.
      const res = await supertest(app).get('/api/v1/health');

      expect(res.status).not.toBe(413);
   });
});
