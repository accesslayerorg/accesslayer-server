import { bigIntReplacer, safeJsonStringify, sanitizeBigInts, serializeBigInt } from './bigint-serializer.utils';

describe('bigIntReplacer', () => {
  it('converts BigInt to string', () => {
    expect(bigIntReplacer('id', 9007199254740993n)).toBe('9007199254740993');
  });

  it('passes non-BigInt values through unchanged', () => {
    expect(bigIntReplacer('n', 42)).toBe(42);
    expect(bigIntReplacer('s', 'hello')).toBe('hello');
    expect(bigIntReplacer('b', true)).toBe(true);
    expect(bigIntReplacer('n', null)).toBeNull();
  });
});

describe('safeJsonStringify', () => {
  it('serializes a top-level BigInt without throwing', () => {
    const json = safeJsonStringify({ id: 1000000000000000001n, label: 'test' });
    expect(json).toBe('{"id":"1000000000000000001","label":"test"}');
  });

  it('serializes nested BigInt values', () => {
    expect(safeJsonStringify({ a: { b: 2n } })).toBe('{"a":{"b":"2"}}');
  });

  it('behaves like JSON.stringify when no BigInt is present', () => {
    expect(safeJsonStringify({ x: 1 })).toBe(JSON.stringify({ x: 1 }));
  });
});

describe('sanitizeBigInts', () => {
  it('converts a top-level BigInt to string', () => {
    expect(sanitizeBigInts(5n)).toBe('5');
  });

  it('converts nested BigInt in an object', () => {
    expect(sanitizeBigInts({ id: 1n, nested: { amount: 500n }, label: 'ok' })).toEqual({
      id: '1',
      nested: { amount: '500' },
      label: 'ok',
    });
  });

  it('converts BigInt inside an array', () => {
    expect(sanitizeBigInts([1n, 2n, 3n])).toEqual(['1', '2', '3']);
  });

  it('passes non-BigInt primitives through unchanged', () => {
    expect(sanitizeBigInts(42)).toBe(42);
    expect(sanitizeBigInts('str')).toBe('str');
  });
});

describe('serializeBigInt', () => {
  it('converts a top-level BigInt to string', () => {
    expect(serializeBigInt(9007199254740993n)).toBe('9007199254740993');
  });

  it('converts nested BigInt in an object', () => {
    expect(serializeBigInt({ amount: 1000n, label: 'x' })).toEqual({ amount: '1000', label: 'x' });
  });

  it('converts BigInt inside an array', () => {
    expect(serializeBigInt([1n, 2n])).toEqual(['1', '2']);
  });

  it('passes non-BigInt values through unchanged', () => {
    expect(serializeBigInt(42)).toBe(42);
    expect(serializeBigInt('hello')).toBe('hello');
    expect(serializeBigInt(true)).toBe(true);
    expect(serializeBigInt(null)).toBeNull();
  });
});
