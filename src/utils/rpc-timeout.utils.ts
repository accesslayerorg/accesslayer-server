// src/utils/rpc-timeout.utils.ts
import { ErrorCode } from '../constants/error.constants';
import { requestContextStorage } from './als.utils';
import { logger } from './logger.utils';

type RpcResponseLike = {
   status?: number;
   endpoint?: string;
   url?: string;
};

/**
 * Structured error thrown when an RPC call exceeds its timeout.
 */
export class RpcTimeoutError extends Error {
   readonly code = ErrorCode.INTERNAL_ERROR;
   readonly isTimeout = true;

   constructor(
      public readonly operation: string,
      public readonly timeoutMs: number
   ) {
      super(`RPC call "${operation}" timed out after ${timeoutMs}ms`);
      this.name = 'RpcTimeoutError';
      Error.captureStackTrace(this, this.constructor);
   }
}

/**
 * Default timeout in milliseconds for outbound RPC calls.
 */
export const DEFAULT_RPC_TIMEOUT_MS = 5000;

function isRpcResponseLike(value: unknown): value is RpcResponseLike {
   return (
      typeof value === 'object' &&
      value !== null &&
      'status' in value &&
      typeof (value as RpcResponseLike).status === 'number'
   );
}

function logUnexpectedRpcStatus(
   operation: string,
   response: RpcResponseLike
): void {
   const status = response.status;
   if (typeof status !== 'number' || (status >= 200 && status < 300)) {
      return;
   }

   const requestId = requestContextStorage.getStore()?.requestId;
   const endpoint = response.endpoint || response.url || operation;

   logger.warn(
      {
         type: 'unexpected_rpc_response_status',
         operation,
         endpoint,
         status,
         ...(requestId ? { requestId } : {}),
      },
      'Unexpected response status from external RPC call'
   );
}

/**
 * Wraps an outbound RPC call with a timeout.
 *
 * If the promise does not resolve within `timeoutMs`, it rejects with
 * a `RpcTimeoutError` that carries a consistent error shape.
 *
 * @param operation - Human-readable name for the call (used in error messages).
 * @param fn - Factory that returns the promise to race against the timeout.
 * @param timeoutMs - Per-call override. Defaults to `DEFAULT_RPC_TIMEOUT_MS`.
 *
 * @example
 * const data = await withRpcTimeout('fetchUserProfile', () => externalApi.getUser(id));
 *
 * @example
 * // Per-call override
 * const data = await withRpcTimeout('slowQuery', () => db.query(), 10_000);
 */
export async function withRpcTimeout<T>(
   operation: string,
   fn: () => Promise<T>,
   timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS
): Promise<T> {
   let timer: ReturnType<typeof setTimeout> | undefined;

   const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
         reject(new RpcTimeoutError(operation, timeoutMs));
      }, timeoutMs);
   });

   try {
      const result = await Promise.race([fn(), timeout]);
      if (isRpcResponseLike(result)) {
         logUnexpectedRpcStatus(operation, result);
      }
      return result;
   } finally {
      clearTimeout(timer);
   }
}
