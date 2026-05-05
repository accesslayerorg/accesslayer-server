// src/constants/error.constants.ts
/**
 * Shared API error codes.
 */
export const ErrorCode = {
   VALIDATION_ERROR: 'VALIDATION_ERROR',
   NOT_FOUND: 'NOT_FOUND',
   UNAUTHORIZED: 'UNAUTHORIZED',
   FORBIDDEN: 'FORBIDDEN',
   CONFLICT: 'CONFLICT',
   BAD_REQUEST: 'BAD_REQUEST',
   INTERNAL_ERROR: 'INTERNAL_ERROR',
   RATE_LIMIT: 'RATE_LIMIT',
   PRISMA_ERROR: 'DATABASE_ERROR',
   JWT_ERROR: 'TOKEN_ERROR',
   PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];
