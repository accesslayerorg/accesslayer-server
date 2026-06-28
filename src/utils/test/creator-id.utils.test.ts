import { parseCreatorId } from '../creator-id.utils';
import { ApiError } from '../../middlewares/error.middleware';

describe('parseCreatorId', () => {
  it('parses a valid positive integer string', () => {
    expect(parseCreatorId('42')).toBe(42);
    expect(parseCreatorId('1')).toBe(1);
    expect(parseCreatorId('999999')).toBe(999999);
  });

  it('parses a trimmed integer string', () => {
    expect(parseCreatorId('  42  ')).toBe(42);
  });

  it('throws a 400 error for a float string', () => {
    expect(() => parseCreatorId('3.14')).toThrow(ApiError);
    expect(() => parseCreatorId('3.14')).toThrow('Creator ID must be a positive integer');
  });

  it('throws a 400 error for a negative number', () => {
    expect(() => parseCreatorId('-5')).toThrow(ApiError);
    expect(() => parseCreatorId('-5')).toThrow('Creator ID must be a positive integer');
  });

  it('throws a 400 error for a non-numeric string', () => {
    expect(() => parseCreatorId('abc')).toThrow(ApiError);
    expect(() => parseCreatorId('abc')).toThrow('Creator ID must be a positive integer');
  });

  it('throws a 400 error for an empty string', () => {
    expect(() => parseCreatorId('')).toThrow(ApiError);
    expect(() => parseCreatorId('')).toThrow('Creator ID is required');
  });

  it('throws a 400 error for a whitespace-only string', () => {
    expect(() => parseCreatorId('   ')).toThrow(ApiError);
    expect(() => parseCreatorId('   ')).toThrow('Creator ID is required');
  });

  it('throws a 400 error for a string with trailing non-digits', () => {
    expect(() => parseCreatorId('42abc')).toThrow(ApiError);
    expect(() => parseCreatorId('42abc')).toThrow('Creator ID must be a positive integer');
  });

  it('throws a 400 error for zero', () => {
    expect(() => parseCreatorId('0')).toThrow(ApiError);
    expect(() => parseCreatorId('0')).toThrow('Creator ID must be a positive integer');
  });

  it('sets statusCode 400 on the thrown error', () => {
    try {
      parseCreatorId('not-a-number');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).statusCode).toBe(400);
    }
  });
});
