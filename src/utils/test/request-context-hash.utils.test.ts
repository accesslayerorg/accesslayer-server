import { Request } from 'express';
import { computeRequestContextHash } from '../request-context-hash.utils';

function makeReq(overrides: Partial<{ method: string; path: string; headers: Record<string, string> }>): Request {
  return {
    method: 'GET',
    path: '/',
    headers: {},
    ...overrides,
  } as unknown as Request;
}

describe('computeRequestContextHash()', () => {
  // ── Output format ──────────────────────────────────────────────────────────

  it('returns a 12-character hex string', () => {
    const hash = computeRequestContextHash(makeReq({}));
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });

  // ── Determinism ────────────────────────────────────────────────────────────

  it('returns the same hash for identical inputs', () => {
    const req = makeReq({ method: 'GET', path: '/api/creators' });
    expect(computeRequestContextHash(req)).toBe(computeRequestContextHash(req));
  });

  it('produces a stable hash across separate calls with matching fields', () => {
    const a = makeReq({ method: 'POST', path: '/api/auth/login', headers: { 'content-type': 'application/json' } });
    const b = makeReq({ method: 'POST', path: '/api/auth/login', headers: { 'content-type': 'application/json' } });
    expect(computeRequestContextHash(a)).toBe(computeRequestContextHash(b));
  });

  // ── Sensitivity to field values ────────────────────────────────────────────

  it('produces different hashes for different HTTP methods', () => {
    const get = makeReq({ method: 'GET', path: '/api/creators' });
    const post = makeReq({ method: 'POST', path: '/api/creators' });
    expect(computeRequestContextHash(get)).not.toBe(computeRequestContextHash(post));
  });

  it('produces different hashes for different paths', () => {
    const a = makeReq({ path: '/api/creators' });
    const b = makeReq({ path: '/api/wallet' });
    expect(computeRequestContextHash(a)).not.toBe(computeRequestContextHash(b));
  });

  it('produces different hashes for different content-type headers', () => {
    const json = makeReq({ method: 'POST', path: '/upload', headers: { 'content-type': 'application/json' } });
    const form = makeReq({ method: 'POST', path: '/upload', headers: { 'content-type': 'multipart/form-data' } });
    expect(computeRequestContextHash(json)).not.toBe(computeRequestContextHash(form));
  });

  // ── Query-string isolation ─────────────────────────────────────────────────

  it('ignores query strings in the path', () => {
    const withQuery = makeReq({ path: '/api/creators?page=1&limit=20' });
    const withoutQuery = makeReq({ path: '/api/creators' });
    expect(computeRequestContextHash(withQuery)).toBe(computeRequestContextHash(withoutQuery));
  });

  it('ignores different query strings for the same path', () => {
    const a = makeReq({ path: '/api/creators?q=music' });
    const b = makeReq({ path: '/api/creators?q=sports&page=2' });
    expect(computeRequestContextHash(a)).toBe(computeRequestContextHash(b));
  });

  // ── Sensitive-header isolation ─────────────────────────────────────────────

  it('produces the same hash regardless of Authorization header value', () => {
    const noAuth = makeReq({ path: '/api/creators', headers: {} });
    const withAuth = makeReq({ path: '/api/creators', headers: { authorization: 'Bearer secret-token' } });
    expect(computeRequestContextHash(noAuth)).toBe(computeRequestContextHash(withAuth));
  });

  it('produces the same hash regardless of Cookie header value', () => {
    const noCookie = makeReq({ path: '/api/creators', headers: {} });
    const withCookie = makeReq({ path: '/api/creators', headers: { cookie: 'session=abc123' } });
    expect(computeRequestContextHash(noCookie)).toBe(computeRequestContextHash(withCookie));
  });

  // ── Content-type charset suffix stripping ─────────────────────────────────

  it('treats content-type with and without charset as the same', () => {
    const plain = makeReq({ method: 'POST', path: '/api/auth', headers: { 'content-type': 'application/json' } });
    const withCharset = makeReq({ method: 'POST', path: '/api/auth', headers: { 'content-type': 'application/json; charset=utf-8' } });
    expect(computeRequestContextHash(plain)).toBe(computeRequestContextHash(withCharset));
  });

  // ── Missing / empty path ───────────────────────────────────────────────────

  it('falls back to "/" when path is empty', () => {
    const emptyPath = makeReq({ path: '' });
    const rootPath = makeReq({ path: '/' });
    expect(computeRequestContextHash(emptyPath)).toBe(computeRequestContextHash(rootPath));
  });

  // ── Method normalisation ───────────────────────────────────────────────────

  it('is case-insensitive for method (get vs GET)', () => {
    const upper = makeReq({ method: 'GET', path: '/api/creators' });
    const lower = makeReq({ method: 'get', path: '/api/creators' });
    expect(computeRequestContextHash(upper)).toBe(computeRequestContextHash(lower));
  });
});
