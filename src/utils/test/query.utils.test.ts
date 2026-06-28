import { normalizeOptionalIntegerQueryParam } from '../query.utils';

describe('normalizeOptionalIntegerQueryParam', () => {
   it('returns default when value is undefined', () => {
      expect(normalizeOptionalIntegerQueryParam(undefined, 10)).toBe(10);
   });

   it('returns default when value is blank after trimming', () => {
      expect(normalizeOptionalIntegerQueryParam('   ', 5)).toBe(5);
   });

   it('parses trimmed integer strings', () => {
      expect(normalizeOptionalIntegerQueryParam(' 42 ', 0)).toBe(42);
   });

   it('rejects non-integer values', () => {
      expect(normalizeOptionalIntegerQueryParam('12abc', 0)).toBeNull();
      expect(normalizeOptionalIntegerQueryParam('3.14', 0)).toBeNull();
   });
});
