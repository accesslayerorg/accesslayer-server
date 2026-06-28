import { buildCreatorFeedWhere } from './creator-feed-filter-combinator.utils';

describe('buildCreatorFeedWhere()', () => {
  it('returns an empty object when no filters are supplied', () => {
    expect(buildCreatorFeedWhere({})).toEqual({});
  });

  it('sets isVerified when verified is true', () => {
    expect(buildCreatorFeedWhere({ verified: true })).toEqual({ isVerified: true });
  });

  it('sets isVerified when verified is false', () => {
    expect(buildCreatorFeedWhere({ verified: false })).toEqual({ isVerified: false });
  });

  it('omits isVerified when verified is undefined', () => {
    const where = buildCreatorFeedWhere({ search: 'jazz' });
    expect('isVerified' in where).toBe(false);
  });

  it('sets OR search clause for handle and displayName', () => {
    const where = buildCreatorFeedWhere({ search: 'jazz' });
    expect(where.OR).toEqual([
      { handle: { contains: 'jazz', mode: 'insensitive' } },
      { displayName: { contains: 'jazz', mode: 'insensitive' } },
    ]);
  });

  it('normalizes whitespace in the search term', () => {
    const where = buildCreatorFeedWhere({ search: '  jazz   musician  ' });
    expect(where.OR?.[0].handle?.contains).toBe('jazz musician');
  });

  it('omits OR clause when search is whitespace-only', () => {
    const where = buildCreatorFeedWhere({ search: '   ' });
    expect('OR' in where).toBe(false);
  });

  it('omits OR clause when search is undefined', () => {
    const where = buildCreatorFeedWhere({ verified: true });
    expect('OR' in where).toBe(false);
  });

  it('combines verified and search filters', () => {
    const where = buildCreatorFeedWhere({ verified: false, search: 'alice' });
    expect(where).toEqual({
      isVerified: false,
      OR: [
        { handle: { contains: 'alice', mode: 'insensitive' } },
        { displayName: { contains: 'alice', mode: 'insensitive' } },
      ],
    });
  });
});
