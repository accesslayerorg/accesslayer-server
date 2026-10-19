// src/constants/error.constants.ts
/**
 * Shared API error codes.
 */
export const ErrorCode = {
   VALIDATION_ERROR: 'VALIDATION_ERROR',
   UNPROCESSABLE_ENTITY: 'UNPROCESSABLE_ENTITY',
   NOT_FOUND: 'NOT_FOUND',
   UNAUTHORIZED: 'UNAUTHORIZED',
   FORBIDDEN: 'FORBIDDEN',
   CONFLICT: 'CONFLICT',
   GONE: 'GONE',
   BAD_REQUEST: 'BAD_REQUEST',
   INTERNAL_ERROR: 'INTERNAL_ERROR',
   SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
   RATE_LIMIT: 'RATE_LIMIT',
   SLIPPAGE_EXCEEDED: 'slippage_exceeded',
   PRISMA_ERROR: 'DATABASE_ERROR',
   JWT_ERROR: 'TOKEN_ERROR',
   INSUFFICIENT_BALANCE: 'insufficient_balance',
   NOT_A_CREATOR: 'not_a_creator',
   TOKEN_EXPIRY_TAMPERED: 'token_expiry_tampered',
   MISSING_IAT: 'missing_iat',
   MEMO_TOO_LONG: 'memo_too_long',
   MEMO_EMPTY: 'memo_empty',
   MEMO_INVALID_ENCODING: 'memo_invalid_encoding',
   TWAP_INVALID: 'TWAPInvalid',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];
