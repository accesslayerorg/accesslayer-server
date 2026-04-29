import { strict as assert } from 'assert';
import { deprecate } from './deprecation.middleware';
import type { Request, Response, NextFunction } from 'express';

// Minimal mock helpers
function mockRes() {
   const headers: Record<string, string> = {};
   return {
      headers,
      setHeader(name: string, value: string) {
         headers[name] = value;
      },
   } as unknown as Response & { headers: Record<string, string> };
}

function mockReq() {
   return {} as Request;
}

function run() {
   // sets Deprecation header
   {
      const res = mockRes();
      let called = false;
      const next: NextFunction = () => { called = true; };
      deprecate({ deprecatedSince: '2026-01-01T00:00:00Z' })(mockReq(), res, next);
      assert.equal(res.headers['Deprecation'], '2026-01-01T00:00:00Z');
      assert.ok(called, 'next() should be called');
   }

   // sets Sunset header when provided
   {
      const res = mockRes();
      deprecate({
         deprecatedSince: '2026-01-01T00:00:00Z',
         sunsetDate: '2026-07-01T00:00:00Z',
      })(mockReq(), res, () => {});
      assert.equal(res.headers['Sunset'], '2026-07-01T00:00:00Z');
   }

   // omits Sunset header when not provided
   {
      const res = mockRes();
      deprecate({ deprecatedSince: '2026-01-01T00:00:00Z' })(mockReq(), res, () => {});
      assert.ok(!('Sunset' in res.headers), 'Sunset should not be set');
   }

   // sets Link header with successor-version rel when provided
   {
      const res = mockRes();
      deprecate({
         deprecatedSince: '2026-01-01T00:00:00Z',
         link: '/api/v2/creators',
      })(mockReq(), res, () => {});
      assert.equal(res.headers['Link'], '</api/v2/creators>; rel="successor-version"');
   }

   // omits Link header when not provided
   {
      const res = mockRes();
      deprecate({ deprecatedSince: '2026-01-01T00:00:00Z' })(mockReq(), res, () => {});
      assert.ok(!('Link' in res.headers), 'Link should not be set');
   }

   console.log('deprecation.middleware tests passed');
}

run();
