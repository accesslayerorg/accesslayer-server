// src/middlewares/trailing-slash-normalizer.middleware.test.ts
//
// Unit tests for the normalizeTrailingSlash middleware.
// Verifies that req.url is mutated correctly and that next() is always called.
// No Express app is spun up — the middleware function is exercised directly.

import type { Request, Response, NextFunction } from 'express';
import { normalizeTrailingSlash } from './trailing-slash-normalizer.middleware';

// ── Minimal mock helpers ───────────────────────────────────────────────────────

function makeReq(url: string): Request {
   return { url } as unknown as Request;
}

function makeRes(): Response {
   return {} as Response;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('normalizeTrailingSlash middleware', () => {
   let next: jest.Mock<void, []>;

   beforeEach(() => {
      next = jest.fn() as jest.Mock<void, NextFunction extends (...args: any[]) => any ? [] : never>;
   });

   // ── next() is always called ──────────────────────────────────────────────

   it('always calls next()', () => {
      normalizeTrailingSlash(makeReq('/some/path'), makeRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
   });

   it('calls next() even when the URL is unchanged', () => {
      normalizeTrailingSlash(makeReq('/'), makeRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
   });

   // ── Root path is preserved ───────────────────────────────────────────────

   it('does not modify the bare root path "/"', () => {
      const req = makeReq('/');
      normalizeTrailingSlash(req, makeRes(), next);
      expect(req.url).toBe('/');
   });

   it('does not modify root path with a query string "/?q=1"', () => {
      const req = makeReq('/?q=1');
      normalizeTrailingSlash(req, makeRes(), next);
      expect(req.url).toBe('/?q=1');
   });

   // ── Trailing slashes are stripped ────────────────────────────────────────

   it('strips a trailing slash from a single-segment path', () => {
      const req = makeReq('/creators/');
      normalizeTrailingSlash(req, makeRes(), next);
      expect(req.url).toBe('/creators');
   });

   it('strips a trailing slash from a multi-segment path', () => {
      const req = makeReq('/123/stats/');
      normalizeTrailingSlash(req, makeRes(), next);
      expect(req.url).toBe('/123/stats');
   });

   it('strips a trailing slash while preserving query string', () => {
      const req = makeReq('/creators/?limit=10&offset=0');
      normalizeTrailingSlash(req, makeRes(), next);
      expect(req.url).toBe('/creators?limit=10&offset=0');
   });

   it('strips a trailing slash from a deeply nested path', () => {
      const req = makeReq('/api/v1/creators/abc/profile/');
      normalizeTrailingSlash(req, makeRes(), next);
      expect(req.url).toBe('/api/v1/creators/abc/profile');
   });

   // ── Paths without trailing slashes are unchanged ──────────────────────────

   it('does not modify a path that has no trailing slash', () => {
      const req = makeReq('/creators');
      normalizeTrailingSlash(req, makeRes(), next);
      expect(req.url).toBe('/creators');
   });

   it('does not modify a path with a query string but no trailing slash', () => {
      const req = makeReq('/creators?limit=5');
      normalizeTrailingSlash(req, makeRes(), next);
      expect(req.url).toBe('/creators?limit=5');
   });

   it('does not modify a multi-segment path without a trailing slash', () => {
      const req = makeReq('/123/stats');
      normalizeTrailingSlash(req, makeRes(), next);
      expect(req.url).toBe('/123/stats');
   });
});
