import { ErrorCode } from '../constants/error.constants';

/** Stellar caps text memos at 28 bytes of UTF-8, not 28 characters. */
export const STELLAR_TEXT_MEMO_MAX_BYTES = 28;

// An unpaired UTF-16 surrogate has no UTF-8 encoding.
const LONE_SURROGATE =
   /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export interface StellarMemoValidationResult {
   valid: boolean;
   code?: string;
   memo?: string;
}

/**
 * Validates a text memo before transaction submission. Rejects empty memos,
 * strings that cannot be encoded as UTF-8 (lone surrogates), and memos whose
 * UTF-8 byte length exceeds the Stellar limit. Valid memos are returned as-is.
 */
export function validateStellarTextMemo(
   memo: string
): StellarMemoValidationResult {
   if (memo.length === 0) {
      return { valid: false, code: ErrorCode.MEMO_EMPTY };
   }

   if (LONE_SURROGATE.test(memo)) {
      return { valid: false, code: ErrorCode.MEMO_INVALID_ENCODING };
   }

   if (Buffer.byteLength(memo, 'utf8') > STELLAR_TEXT_MEMO_MAX_BYTES) {
      return { valid: false, code: ErrorCode.MEMO_TOO_LONG };
   }

   return { valid: true, memo };
}
