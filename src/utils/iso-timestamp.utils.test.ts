import { formatIsoTimestamp, parseISOTimestamp, InvalidTimestamp } from './iso-timestamp.utils';

describe('formatIsoTimestamp()', () => {
   it('formats supported timestamp inputs with one ISO 8601 UTC representation', () => {
      const expected = '2024-01-02T03:04:05.678Z';

      expect(formatIsoTimestamp(new Date(expected))).toBe(expected);
      expect(formatIsoTimestamp('2024-01-02T04:04:05.678+01:00')).toBe(
         expected
      );
      expect(formatIsoTimestamp(Date.parse(expected))).toBe(expected);
   });

   it('rejects invalid timestamp values', () => {
      expect(() => formatIsoTimestamp('not-a-date')).toThrow(RangeError);
   });
});

describe('parseISOTimestamp()', () => {
   // Acceptance criterion: valid ISO string returns correct UTC Date
   it('returns the correct UTC Date for a valid ISO 8601 string with Z designator', () => {
      const input = '2024-01-02T03:04:05.678Z';
      const result = parseISOTimestamp(input);

      expect(result).toBeInstanceOf(Date);
      expect(result.toISOString()).toBe(input);
   });

   it('returns the correct UTC Date for a valid ISO 8601 string with offset designator', () => {
      const result = parseISOTimestamp('2024-01-02T04:04:05.678+01:00');

      expect(result).toBeInstanceOf(Date);
      expect(result.toISOString()).toBe('2024-01-02T03:04:05.678Z');
   });

   it('returns the correct UTC Date for a valid ISO 8601 string without milliseconds', () => {
      const result = parseISOTimestamp('2024-06-15T12:00:00Z');

      expect(result).toBeInstanceOf(Date);
      expect(result.getUTCFullYear()).toBe(2024);
      expect(result.getUTCMonth()).toBe(5); // June is month index 5
      expect(result.getUTCDate()).toBe(15);
   });

   // Acceptance criterion: invalid string throws InvalidTimestamp
   it('throws InvalidTimestamp for a non-ISO string', () => {
      expect(() => parseISOTimestamp('not-a-date')).toThrow(InvalidTimestamp);
   });

   it('thrown error identifies the bad input value', () => {
      const value = 'garbage';
      try {
         parseISOTimestamp(value);
         fail('Expected InvalidTimestamp to be thrown');
      } catch (err) {
         expect(err).toBeInstanceOf(InvalidTimestamp);
         expect((err as InvalidTimestamp).message).toContain(value);
         expect((err as InvalidTimestamp).name).toBe('InvalidTimestamp');
      }
   });

   // Acceptance criterion: empty string throws InvalidTimestamp
   it('throws InvalidTimestamp for an empty string', () => {
      expect(() => parseISOTimestamp('')).toThrow(InvalidTimestamp);
   });

   // Acceptance criterion: Unix timestamp string throws InvalidTimestamp
   it('throws InvalidTimestamp for a Unix timestamp string', () => {
      expect(() => parseISOTimestamp('1704153845000')).toThrow(InvalidTimestamp);
   });

   it('throws InvalidTimestamp for a bare date string (no time component)', () => {
      expect(() => parseISOTimestamp('2024-01-02')).toThrow(InvalidTimestamp);
   });
});
