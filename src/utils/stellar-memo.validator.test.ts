import {
   STELLAR_TEXT_MEMO_MAX_BYTES,
   validateStellarTextMemo,
} from './stellar-memo.validator';

describe('validateStellarTextMemo', () => {
   it('accepts a memo of exactly 28 ASCII characters', () => {
      const memo = 'a'.repeat(STELLAR_TEXT_MEMO_MAX_BYTES);

      expect(validateStellarTextMemo(memo)).toEqual({ valid: true, memo });
   });

   it('rejects a memo of 29 ASCII characters with memo_too_long', () => {
      const result = validateStellarTextMemo('a'.repeat(29));

      expect(result.valid).toBe(false);
      expect(result.code).toBe('memo_too_long');
   });

   it('counts multi-byte characters by byte length, not character count', () => {
      // 28 characters, but each "é" is 2 bytes in UTF-8 (56 bytes total).
      const memo = 'é'.repeat(28);
      expect(memo).toHaveLength(28);

      const result = validateStellarTextMemo(memo);

      expect(result.valid).toBe(false);
      expect(result.code).toBe('memo_too_long');
   });

   it('accepts multi-byte characters that fit within 28 bytes', () => {
      // 14 x 2-byte characters = 28 bytes exactly.
      const memo = 'é'.repeat(14);

      expect(validateStellarTextMemo(memo)).toEqual({ valid: true, memo });
   });

   it('rejects a 4-byte emoji sequence that crosses the limit', () => {
      // 7 emoji x 4 bytes = 28 bytes passes; one more byte does not.
      expect(validateStellarTextMemo('🔑'.repeat(7)).valid).toBe(true);
      expect(validateStellarTextMemo(`${'🔑'.repeat(7)}a`).code).toBe(
         'memo_too_long'
      );
   });

   it('rejects an empty memo with memo_empty', () => {
      const result = validateStellarTextMemo('');

      expect(result.valid).toBe(false);
      expect(result.code).toBe('memo_empty');
   });

   it('rejects a memo with an unpaired surrogate as non-UTF-8', () => {
      const result = validateStellarTextMemo('order\uD83D');

      expect(result.valid).toBe(false);
      expect(result.code).toBe('memo_invalid_encoding');
   });

   it('passes a valid short memo through unchanged', () => {
      const result = validateStellarTextMemo('order-42');

      expect(result).toEqual({ valid: true, memo: 'order-42' });
      expect(result.code).toBeUndefined();
   });
});
