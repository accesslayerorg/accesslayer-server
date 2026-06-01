/**
 * Unit tests for log field sanitization utility.
 *
 * Covers sanitization of control characters (newline, carriage return, tab, etc.)
 * to prevent log injection attacks.
 */

import {
   sanitizeLogFieldValue,
   sanitizeLogObject,
} from './log-field-sanitizer.utils';

describe('sanitizeLogFieldValue', () => {
   // ── Newline Character Tests ────────────────────────────────────────────────

   it('escapes newline characters', () => {
      const input = 'search\nterm';
      const result = sanitizeLogFieldValue(input);
      expect(result).toBe('search\\nterm');
   });

   it('escapes multiple newlines', () => {
      const input = 'line1\nline2\nline3';
      const result = sanitizeLogFieldValue(input);
      expect(result).toBe('line1\\nline2\\nline3');
   });

   // ── Carriage Return Character Tests ────────────────────────────────────────

   it('escapes carriage return characters', () => {
      const input = 'handle\rname';
      const result = sanitizeLogFieldValue(input);
      expect(result).toBe('handle\\rname');
   });

   it('escapes multiple carriage returns', () => {
      const input = 'text\rmore\rtext';
      const result = sanitizeLogFieldValue(input);
      expect(result).toBe('text\\rmore\\rtext');
   });

   // ── Tab Character Tests ───────────────────────────────────────────────────

   it('escapes tab characters', () => {
      const input = 'field\tvalue';
      const result = sanitizeLogFieldValue(input);
      expect(result).toBe('field\\tvalue');
   });

   it('escapes multiple tabs', () => {
      const input = 'col1\tcol2\tcol3';
      const result = sanitizeLogFieldValue(input);
      expect(result).toBe('col1\\tcol2\\tcol3');
   });

   // ── Mixed Control Character Tests ──────────────────────────────────────────

   it('escapes mixed control characters', () => {
      const input = 'search\nterm\rwith\ttabs';
      const result = sanitizeLogFieldValue(input);
      expect(result).toBe('search\\nterm\\rwith\\ttabs');
   });

   it('escapes form feed characters', () => {
      const input = 'text\fmore';
      const result = sanitizeLogFieldValue(input);
      expect(result).toBe('text\\fmore');
   });

   it('escapes vertical tab characters', () => {
      const input = 'text\vmore';
      const result = sanitizeLogFieldValue(input);
      expect(result).toBe('text\\vmore');
   });

   it('escapes null characters', () => {
      const input = 'text\0more';
      const result = sanitizeLogFieldValue(input);
      expect(result).toBe('text\\0more');
   });

   // ── Edge Cases ─────────────────────────────────────────────────────────────

   it('returns empty string for null input', () => {
      const result = sanitizeLogFieldValue(null);
      expect(result).toBe('');
   });

   it('returns empty string for undefined input', () => {
      const result = sanitizeLogFieldValue(undefined);
      expect(result).toBe('');
   });

   it('returns unchanged string with no control characters', () => {
      const input = 'normal string with no control chars';
      const result = sanitizeLogFieldValue(input);
      expect(result).toBe(input);
   });

   it('converts non-string values to string and sanitizes', () => {
      const result = sanitizeLogFieldValue(42);
      expect(result).toBe('42');
   });

   it('converts boolean values to string', () => {
      const result = sanitizeLogFieldValue(true);
      expect(result).toBe('true');
   });

   it('handles strings with only control characters', () => {
      const input = '\n\r\t';
      const result = sanitizeLogFieldValue(input);
      expect(result).toBe('\\n\\r\\t');
   });

   it('preserves special characters that are not control chars', () => {
      const input = 'special!@#$%^&*()_+-=[]{}|;:,.<>?';
      const result = sanitizeLogFieldValue(input);
      expect(result).toBe(input);
   });

   it('preserves unicode characters', () => {
      const input = 'unicode: 你好 🎉 café';
      const result = sanitizeLogFieldValue(input);
      expect(result).toBe(input);
   });
});

describe('sanitizeLogObject', () => {
   // ── String Value Sanitization ──────────────────────────────────────────────

   it('sanitizes string values in a flat object', () => {
      const input = {
         search: 'term\nwith\nnewlines',
         handle: 'user\rname',
      };
      const result = sanitizeLogObject(input);
      expect(result).toEqual({
         search: 'term\\nwith\\nnewlines',
         handle: 'user\\rname',
      });
   });

   // ── Nested Object Sanitization ─────────────────────────────────────────────

   it('sanitizes nested objects recursively', () => {
      const input = {
         user: {
            search: 'query\nwith\nnewline',
            profile: {
               handle: 'handle\rwith\rcarriage',
            },
         },
      };
      const result = sanitizeLogObject(input);
      expect(result).toEqual({
         user: {
            search: 'query\\nwith\\nnewline',
            profile: {
               handle: 'handle\\rwith\\rcarriage',
            },
         },
      });
   });

   // ── Array Sanitization ─────────────────────────────────────────────────────

   it('sanitizes string values in arrays', () => {
      const input = {
         items: ['item\nwith\nnewline', 'normal item', 'tab\there'],
      };
      const result = sanitizeLogObject(input);
      expect(result).toEqual({
         items: ['item\\nwith\\nnewline', 'normal item', 'tab\\there'],
      });
   });

   it('sanitizes nested arrays of objects', () => {
      const input = {
         results: [{ name: 'name\nwith\nnewline' }, { name: 'normal\rname' }],
      };
      const result = sanitizeLogObject(input);
      expect(result).toEqual({
         results: [
            { name: 'name\\nwith\\nnewline' },
            { name: 'normal\\rname' },
         ],
      });
   });

   // ── Non-String Value Preservation ──────────────────────────────────────────

   it('preserves non-string values unchanged', () => {
      const input = {
         count: 42,
         active: true,
         ratio: 3.14,
         empty: null,
         missing: undefined,
      };
      const result = sanitizeLogObject(input);
      expect(result).toEqual(input);
   });

   it('preserves mixed types in objects', () => {
      const input = {
         search: 'term\nwith\nnewline',
         count: 42,
         active: true,
         nested: {
            value: 'nested\rvalue',
            number: 100,
         },
      };
      const result = sanitizeLogObject(input);
      expect(result).toEqual({
         search: 'term\\nwith\\nnewline',
         count: 42,
         active: true,
         nested: {
            value: 'nested\\rvalue',
            number: 100,
         },
      });
   });

   // ── Edge Cases ─────────────────────────────────────────────────────────────

   it('handles null input', () => {
      const result = sanitizeLogObject(null);
      expect(result).toBeNull();
   });

   it('handles undefined input', () => {
      const result = sanitizeLogObject(undefined);
      expect(result).toBeUndefined();
   });

   it('handles empty object', () => {
      const result = sanitizeLogObject({});
      expect(result).toEqual({});
   });

   it('handles empty array', () => {
      const result = sanitizeLogObject([]);
      expect(result).toEqual([]);
   });

   it('does not mutate original object', () => {
      const input = {
         search: 'term\nwith\nnewline',
         count: 42,
      };
      const original = JSON.parse(JSON.stringify(input));
      sanitizeLogObject(input);
      expect(input).toEqual(original);
   });

   it('handles deeply nested structures', () => {
      const input = {
         level1: {
            level2: {
               level3: {
                  value: 'deep\nvalue',
               },
            },
         },
      };
      const result = sanitizeLogObject(input);
      expect(result).toEqual({
         level1: {
            level2: {
               level3: {
                  value: 'deep\\nvalue',
               },
            },
         },
      });
   });

   it('handles arrays with mixed types', () => {
      const input = {
         mixed: [
            'string\nwith\nnewline',
            42,
            true,
            { nested: 'value\rwith\rcarriage' },
            null,
         ],
      };
      const result = sanitizeLogObject(input);
      expect(result).toEqual({
         mixed: [
            'string\\nwith\\nnewline',
            42,
            true,
            { nested: 'value\\rwith\\rcarriage' },
            null,
         ],
      });
   });
});
