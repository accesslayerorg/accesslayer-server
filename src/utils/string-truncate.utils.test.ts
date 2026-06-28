import { truncateString } from './string-truncate.utils';

describe('truncateString', () => {
   it('returns the original string when it is below the limit', () => {
      expect(truncateString('hello', 10)).toBe('hello');
   });

   it('returns the original string when it exactly matches the limit', () => {
      expect(truncateString('hello', 5)).toBe('hello');
   });

   it('truncates the string when it exceeds the limit', () => {
      expect(truncateString('hello world', 5)).toBe('hello');
   });

   it('rejects negative limits', () => {
      expect(() => truncateString('hello', -1)).toThrow(
         'maxLength must be a non-negative finite number'
      );
   });
});
