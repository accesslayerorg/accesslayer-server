import { readQueryParam } from './query-param.utils';

describe('readQueryParam — string type', () => {
  it('returns the string value when present', () => {
    expect(readQueryParam({ q: 'hello' }, 'q', 'string', 'default')).toBe('hello');
  });

  it('returns defaultValue when param is missing', () => {
    expect(readQueryParam({}, 'q', 'string', 'default')).toBe('default');
  });

  it('returns defaultValue when param is empty string', () => {
    expect(readQueryParam({ q: '' }, 'q', 'string', 'default')).toBe('default');
  });

  it('returns defaultValue when param is null', () => {
    expect(readQueryParam({ q: null }, 'q', 'string', 'fallback')).toBe('fallback');
  });

  it('uses first element of array value', () => {
    expect(readQueryParam({ q: ['first', 'second'] }, 'q', 'string', 'x')).toBe('first');
  });

  it('returns undefined defaultValue when absent and default is undefined', () => {
    expect(readQueryParam({}, 'q', 'string', undefined)).toBeUndefined();
  });
});

describe('readQueryParam — number type', () => {
  it('returns parsed integer when param is a valid non-negative number string', () => {
    expect(readQueryParam({ n: '42' }, 'n', 'number', 0)).toBe(42);
  });

  it('returns 0 as a valid value', () => {
    expect(readQueryParam({ n: '0' }, 'n', 'number', 99)).toBe(0);
  });

  it('returns defaultValue when param is missing', () => {
    expect(readQueryParam({}, 'n', 'number', 10)).toBe(10);
  });

  it('returns defaultValue when param is NaN', () => {
    expect(readQueryParam({ n: 'abc' }, 'n', 'number', 5)).toBe(5);
  });

  it('returns defaultValue when param is negative', () => {
    expect(readQueryParam({ n: '-1' }, 'n', 'number', 7)).toBe(7);
  });

  it('returns defaultValue when param is a float string (not an integer)', () => {
    expect(readQueryParam({ n: '3.14' }, 'n', 'number', 0)).toBe(3);
  });

  it('returns defaultValue when param is empty string', () => {
    expect(readQueryParam({ n: '' }, 'n', 'number', 99)).toBe(99);
  });

  it('uses first element of array value', () => {
    expect(readQueryParam({ n: ['7', '8'] }, 'n', 'number', 0)).toBe(7);
  });
});

describe('readQueryParam — boolean type', () => {
  it('returns true for "true"', () => {
    expect(readQueryParam({ b: 'true' }, 'b', 'boolean', false)).toBe(true);
  });

  it('returns false for "false"', () => {
    expect(readQueryParam({ b: 'false' }, 'b', 'boolean', true)).toBe(false);
  });

  it('is case-insensitive — accepts "True"', () => {
    expect(readQueryParam({ b: 'True' }, 'b', 'boolean', false)).toBe(true);
  });

  it('is case-insensitive — accepts "FALSE"', () => {
    expect(readQueryParam({ b: 'FALSE' }, 'b', 'boolean', true)).toBe(false);
  });

  it('returns defaultValue when param is missing', () => {
    expect(readQueryParam({}, 'b', 'boolean', true)).toBe(true);
  });

  it('returns defaultValue for invalid string "yes"', () => {
    expect(readQueryParam({ b: 'yes' }, 'b', 'boolean', false)).toBe(false);
  });

  it('returns defaultValue for invalid string "1"', () => {
    expect(readQueryParam({ b: '1' }, 'b', 'boolean', false)).toBe(false);
  });

  it('returns defaultValue for invalid string "0"', () => {
    expect(readQueryParam({ b: '0' }, 'b', 'boolean', true)).toBe(true);
  });

  it('returns defaultValue when param is empty string', () => {
    expect(readQueryParam({ b: '' }, 'b', 'boolean', true)).toBe(true);
  });

  it('uses first element of array value', () => {
    expect(readQueryParam({ b: ['true', 'false'] }, 'b', 'boolean', false)).toBe(true);
  });
});
