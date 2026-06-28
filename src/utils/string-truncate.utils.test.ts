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
   const encoder = new TextEncoder();

   it('returns original ASCII string when within limit', () => {
      const result = truncateToBytes('hello', 10);
      expect(result).toBe('hello');
      expect(encoder.encode(result).length).toBeLessThanOrEqual(10);
   });

   it('truncates ASCII string when over limit', () => {
      const result = truncateToBytes('hello world', 5);
      expect(result).toBe('hello');
      expect(encoder.encode(result).length).toBe(5);
   });

   it('truncates multi-byte string at character boundary', () => {
      const multiByteStr = 'こんにちは世界'; // Each Japanese character is 3 bytes
      const result = truncateToBytes(multiByteStr, 10); // Should fit 3 characters (9 bytes)
      expect(result).toBe('こんに');
      expect(encoder.encode(result).length).toBe(9);
   });

   it('returns empty string unchanged', () => {
      const result = truncateToBytes('', 100);
      expect(result).toBe('');
      expect(encoder.encode(result).length).toBe(0);
   });

   it('rejects negative maxBytes', () => {
      expect(() => truncateToBytes('hello', -1)).toThrow(
         'maxBytes must be a non-negative finite number'
      );
   });
});
