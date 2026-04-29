import { withTieBreaker, stableSortCreators } from '../sort-tiebreaker.utils';

type Creator = { id: string; name: string; followers: number };

function makeCreator(id: string, name: string, followers: number): Creator {
  return { id, name, followers };
}

describe('withTieBreaker()', () => {
  const cmp = withTieBreaker<Creator>('followers', 'asc');

  it('orders lower followers before higher (asc)', () => {
    const a = makeCreator('1', 'Alice', 10);
    const b = makeCreator('2', 'Bob', 20);
    expect(cmp(a, b)).toBeLessThan(0);
    expect(cmp(b, a)).toBeGreaterThan(0);
  });

  it('orders higher followers before lower (desc)', () => {
    const cmpDesc = withTieBreaker<Creator>('followers', 'desc');
    const a = makeCreator('1', 'Alice', 30);
    const b = makeCreator('2', 'Bob', 10);
    expect(cmpDesc(a, b)).toBeLessThan(0);
    expect(cmpDesc(b, a)).toBeGreaterThan(0);
  });

  it('breaks tie by id ascending when primary values are equal', () => {
    const a = makeCreator('aaa', 'Alice', 50);
    const b = makeCreator('bbb', 'Bob', 50);
    expect(cmp(a, b)).toBeLessThan(0); // 'aaa' < 'bbb'
    expect(cmp(b, a)).toBeGreaterThan(0);
  });

  it('returns 0 only when both primary key and id are equal', () => {
    const a = makeCreator('same', 'Alice', 50);
    const b = makeCreator('same', 'Bob', 50);
    expect(cmp(a, b)).toBe(0);
  });

  it('tie-break direction is always ascending regardless of primary direction', () => {
    const cmpDesc = withTieBreaker<Creator>('followers', 'desc');
    const a = makeCreator('aaa', 'Alice', 50);
    const b = makeCreator('bbb', 'Bob', 50);
    // Equal followers → tie-break by id ascending: 'aaa' < 'bbb'
    expect(cmpDesc(a, b)).toBeLessThan(0);
    expect(cmpDesc(b, a)).toBeGreaterThan(0);
  });

  it('works with string primary key', () => {
    const cmpName = withTieBreaker<Creator>('name', 'asc');
    const a = makeCreator('2', 'Alice', 10);
    const b = makeCreator('1', 'Bob', 20);
    expect(cmpName(a, b)).toBeLessThan(0); // 'Alice' < 'Bob'
  });
});

describe('stableSortCreators()', () => {
  it('does not mutate the original array', () => {
    const items = [makeCreator('b', 'B', 10), makeCreator('a', 'A', 10)];
    const sorted = stableSortCreators(items, 'id');
    expect(sorted).not.toBe(items);
    expect(items[0].id).toBe('b'); // original unchanged
  });

  it('sorts by followers descending with id tie-breaker', () => {
    const items = [
      makeCreator('c', 'C', 30),
      makeCreator('a', 'A', 50),
      makeCreator('b', 'B', 50),
    ];
    const sorted = stableSortCreators(items, 'followers', 'desc');
    expect(sorted[0].id).toBe('a'); // 50 followers, id 'a' < 'b'
    expect(sorted[1].id).toBe('b'); // 50 followers, id 'b'
    expect(sorted[2].id).toBe('c'); // 30 followers
  });

  it('sorts by name ascending with id tie-breaker', () => {
    const items = [
      makeCreator('z', 'Beta', 5),
      makeCreator('a', 'Alpha', 5),
      makeCreator('m', 'Alpha', 10),
    ];
    const sorted = stableSortCreators(items, 'name', 'asc');
    expect(sorted[0].id).toBe('a'); // Alpha, id 'a'
    expect(sorted[1].id).toBe('m'); // Alpha, id 'm'
    expect(sorted[2].id).toBe('z'); // Beta
  });

  it('produces deterministic output on repeated calls', () => {
    const items = [
      makeCreator('c', 'C', 50),
      makeCreator('a', 'A', 50),
      makeCreator('b', 'B', 50),
    ];
    const s1 = stableSortCreators(items, 'followers', 'desc');
    const s2 = stableSortCreators(items, 'followers', 'desc');
    expect(s1.map((i) => i.id)).toEqual(s2.map((i) => i.id));
  });

  it('returns empty array for empty input', () => {
    expect(stableSortCreators([], 'followers')).toEqual([]);
  });

  it('returns single-element array unchanged', () => {
    const item = makeCreator('x', 'X', 99);
    expect(stableSortCreators([item], 'followers')).toEqual([item]);
  });
});
