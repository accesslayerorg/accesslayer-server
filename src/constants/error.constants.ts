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
   BAD_REQUEST: 'BAD_REQUEST',
   INTERNAL_ERROR: 'INTERNAL_ERROR',
   RATE_LIMIT: 'RATE_LIMIT',
   PRISMA_ERROR: 'DATABASE_ERROR',
   JWT_ERROR: 'TOKEN_ERROR',
   INSUFFICIENT_BALANCE: 'insufficient_balance',
   NOT_A_CREATOR: 'not_a_creator',
   UNPROCESSABLE_ENTITY: 'UNPROCESSABLE_ENTITY',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];
