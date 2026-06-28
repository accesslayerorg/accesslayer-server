import { parsePositiveInt } from './parse-positive-int.utils';

describe('parsePositiveInt', () => {
   it('should parse valid positive integer', () => {
      expect(parsePositiveInt('42', 'TEST_VAR', 10)).toBe(42);
      expect(parsePositiveInt('1', 'TEST_VAR', 10)).toBe(1);
      expect(parsePositiveInt('1000', 'TEST_VAR', 10)).toBe(1000);
   });

   it('should return default value when undefined', () => {
      expect(parsePositiveInt(undefined, 'TEST_VAR', 50)).toBe(50);
   });

   it('should throw error for zero', () => {
      expect(() => parsePositiveInt('0', 'TEST_VAR', 10)).toThrow(
         'Configuration error: TEST_VAR="0" must be a positive integer (> 0).'
      );
   });

   it('should throw error for negative numbers', () => {
      expect(() => parsePositiveInt('-5', 'TEST_VAR', 10)).toThrow(
         'Configuration error: TEST_VAR="-5" must be a positive integer (> 0).'
      );
      expect(() => parsePositiveInt('-1', 'TEST_VAR', 10)).toThrow(
         'Configuration error: TEST_VAR="-1" must be a positive integer (> 0).'
      );
   });

   it('should throw error for non-numeric strings', () => {
      expect(() => parsePositiveInt('abc', 'TEST_VAR', 10)).toThrow(
         'Configuration error: TEST_VAR="abc" is not a valid integer. Expected a positive integer.'
      );
      expect(() => parsePositiveInt('12.5', 'TEST_VAR', 10)).toThrow(
         'Configuration error: TEST_VAR="12.5" is not a valid integer. Expected a positive integer.'
      );
   });

   it('should throw error for float strings', () => {
      expect(() => parsePositiveInt('3.14', 'TEST_VAR', 10)).toThrow(
         'Configuration error: TEST_VAR="3.14" is not a valid integer. Expected a positive integer.'
      );
   });

   it('should throw error for empty string', () => {
      expect(() => parsePositiveInt('', 'TEST_VAR', 10)).toThrow(
         'Configuration error: TEST_VAR is defined but empty. Expected a positive integer or leave undefined to use default (10).'
      );
   });

   it('should trim whitespace before parsing', () => {
      expect(parsePositiveInt('  42  ', 'TEST_VAR', 10)).toBe(42);
   });

   it('should include variable name in error messages', () => {
      expect(() => parsePositiveInt('invalid', 'MY_CONFIG', 10)).toThrow(
         'MY_CONFIG'
      );
   });
});
