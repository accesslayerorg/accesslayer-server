import { formatIsoTimestamp } from './iso-timestamp.utils';

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
