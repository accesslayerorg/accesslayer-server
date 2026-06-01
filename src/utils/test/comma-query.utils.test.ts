import { parseCommaQuery } from '../comma-query.utils';

describe('parseCommaQuery()', () => {
  // ── Null / undefined ──────────────────────────────────────────────────────

  it('returns [] for undefined', () => {
    expect(parseCommaQuery(undefined)).toEqual([]);
  });

  it('returns [] for null', () => {
    expect(parseCommaQuery(null)).toEqual([]);
  });

  // ── Empty / whitespace-only input ─────────────────────────────────────────

  it('returns [] for empty string', () => {
    expect(parseCommaQuery('')).toEqual([]);
  });

  it('returns [] for whitespace-only string', () => {
    expect(parseCommaQuery('   ')).toEqual([]);
  });

  it('returns [] for commas-only string', () => {
    expect(parseCommaQuery(',,,,')).toEqual([]);
  });

  // ── Single value ──────────────────────────────────────────────────────────

  it('returns single-element array for a plain string', () => {
    expect(parseCommaQuery('alpha')).toEqual(['alpha']);
  });

  it('trims a single token', () => {
    expect(parseCommaQuery('  alpha  ')).toEqual(['alpha']);
  });

  // ── Multiple values ───────────────────────────────────────────────────────

  it('splits on commas', () => {
    expect(parseCommaQuery('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('trims each token', () => {
    expect(parseCommaQuery('a, b , c')).toEqual(['a', 'b', 'c']);
  });

  it('drops empty tokens between commas', () => {
    expect(parseCommaQuery('a,,b')).toEqual(['a', 'b']);
  });

  it('drops whitespace-only tokens', () => {
    expect(parseCommaQuery('a, , b')).toEqual(['a', 'b']);
  });

  // ── Deduplication ─────────────────────────────────────────────────────────

  it('deduplicates identical tokens', () => {
    expect(parseCommaQuery('a,b,a')).toEqual(['a', 'b']);
  });

  it('preserves first-occurrence order during deduplication', () => {
    expect(parseCommaQuery('c,a,b,a,c')).toEqual(['c', 'a', 'b']);
  });

  it('deduplication is case-sensitive', () => {
    expect(parseCommaQuery('A,a,A')).toEqual(['A', 'a']);
  });

  // ── Array input ───────────────────────────────────────────────────────────

  it('handles string[] by flattening', () => {
    expect(parseCommaQuery(['a,b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('deduplicates across array elements', () => {
    expect(parseCommaQuery(['a,b', 'b,c'])).toEqual(['a', 'b', 'c']);
  });

  it('trims tokens coming from array input', () => {
    expect(parseCommaQuery([' a , b ', ' c '])).toEqual(['a', 'b', 'c']);
  });

  it('returns [] for array of empty strings', () => {
    expect(parseCommaQuery(['', '', ''])).toEqual([]);
  });

  // ── Real-world query-string shapes ───────────────────────────────────────

  it('handles typical multi-tag filter string', () => {
    expect(parseCommaQuery('music, sports , art,music')).toEqual(['music', 'sports', 'art']);
  });
});
