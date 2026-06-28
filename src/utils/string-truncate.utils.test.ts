import { truncateString, truncateToBytes } from './string-truncate.utils';

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

describe('truncateToBytes', () => {
   it('returns ASCII strings unchanged when they fit within the byte limit', () => {
      expect(truncateToBytes('hello', 10)).toBe('hello');
   });

   it('truncates ASCII strings at the byte limit', () => {
      const result = truncateToBytes('hello world', 5);

      expect(result).toBe('hello');
      expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(5);
   });

   it('does not split multi-byte characters', () => {
      const result = truncateToBytes('你好世界', 7);

      expect(result).toBe('你好');
      expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(7);
   });

   it('returns empty strings unchanged', () => {
      expect(truncateToBytes('', 5)).toBe('');
   });

   it('returns an empty string when the first character exceeds the byte limit', () => {
      const result = truncateToBytes('你', 2);

      expect(result).toBe('');
      expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(2);
   });

   it('rejects negative byte limits', () => {
      expect(() => truncateToBytes('hello', -1)).toThrow(
         'maxBytes must be a non-negative finite number'
      );
   });
});
