import { hashRequestBody } from '../hash-request-body.utils';

describe('hashRequestBody()', () => {
  // ── Output format ──────────────────────────────────────────────────────────

  it('returns a 64-character hex string', () => {
    const hash = hashRequestBody({});
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  // ── Determinism ────────────────────────────────────────────────────────────

  it('returns the same hash for identical objects', () => {
    const body = { name: 'alert', channel: 'email' };
    expect(hashRequestBody(body)).toBe(hashRequestBody(body));
  });

  it('produces the same hash for objects with keys in different insertion order', () => {
    const a: Record<string, unknown> = { name: 'alert', channel: 'email' };
    const b: Record<string, unknown> = { channel: 'email', name: 'alert' };
    expect(hashRequestBody(a)).toBe(hashRequestBody(b));
  });

  // ── Sensitivity to values ──────────────────────────────────────────────────

  it('produces different hashes for different objects', () => {
    const a = { name: 'alert', channel: 'email' };
    const b = { name: 'webhook', channel: 'slack' };
    expect(hashRequestBody(a)).not.toBe(hashRequestBody(b));
  });

  it('produces different hashes when a single field value changes', () => {
    const a = { name: 'alert', channel: 'email' };
    const b = { name: 'alert', channel: 'sms' };
    expect(hashRequestBody(a)).not.toBe(hashRequestBody(b));
  });

  // ── Empty object ───────────────────────────────────────────────────────────

  it('produces a stable hash for an empty object', () => {
    const first = hashRequestBody({});
    const second = hashRequestBody({});
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  // ── Primitive and edge-case inputs ─────────────────────────────────────────

  it('hashes null consistently', () => {
    expect(hashRequestBody(null)).toBe(hashRequestBody(null));
  });

  it('hashes undefined consistently', () => {
    expect(hashRequestBody(undefined)).toBe(hashRequestBody(undefined));
  });

  it('hashes strings consistently', () => {
    expect(hashRequestBody('hello')).toBe(hashRequestBody('hello'));
  });

  it('produces different hashes for different strings', () => {
    expect(hashRequestBody('hello')).not.toBe(hashRequestBody('world'));
  });

  it('hashes numbers consistently', () => {
    expect(hashRequestBody(42)).toBe(hashRequestBody(42));
  });

  it('produces different hashes for different numbers', () => {
    expect(hashRequestBody(1)).not.toBe(hashRequestBody(2));
  });

  it('hashes booleans consistently', () => {
    expect(hashRequestBody(true)).toBe(hashRequestBody(true));
    expect(hashRequestBody(false)).toBe(hashRequestBody(false));
  });

  it('hashes arrays consistently', () => {
    expect(hashRequestBody([1, 2, 3])).toBe(hashRequestBody([1, 2, 3]));
  });

  it('produces different hashes for different arrays', () => {
    expect(hashRequestBody([1, 2, 3])).not.toBe(hashRequestBody([1, 2, 4]));
  });

  it('produces the same hash for objects with undefined values', () => {
    const a: Record<string, unknown> = { a: 1, b: undefined };
    const b: Record<string, unknown> = { b: undefined, a: 1 };
    expect(hashRequestBody(a)).toBe(hashRequestBody(b));
  });

  it('hashes nested objects consistently', () => {
    const body = { alert: { name: 'test', settings: { retries: 3 } } };
    expect(hashRequestBody(body)).toBe(hashRequestBody(body));
  });

  it('produces different hashes for different nested objects', () => {
    const a = { alert: { name: 'test', retries: 3 } };
    const b = { alert: { name: 'test', retries: 5 } };
    expect(hashRequestBody(a)).not.toBe(hashRequestBody(b));
  });
});
