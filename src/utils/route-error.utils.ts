import { ErrorCode, ErrorCodeType } from '../constants/error.constants';

export interface RouteSafeErrorEnvelope {
   success: false;
   code: ErrorCodeType;
   message: string;
   requestId?: string;
   stack?: string;
   error?: unknown;
}

export interface RouteSafeErrorResult {
   statusCode: number;
   body: RouteSafeErrorEnvelope;
}

export interface MapUnknownRouteErrorOptions {
   requestId?: string;
   includeDebug?: boolean;
}

/**
 * Maps an unknown error thrown from a route handler to a safe API error envelope.
 *
 * The helper is intended for the fallback path only — known errors (Zod, JWT,
 * Prisma, ApiError, payload-too-large, malformed JSON, etc.) should still be
 * mapped by their dedicated branches in the global error middleware so their
 * existing status codes and codes are preserved.
 *
 * In production-safe mode (`includeDebug=false`) the message is generic and no
 * stack or raw error is leaked. When `includeDebug` is true (development) the
 * original message and stack are surfaced for local debugging.
 *
 * The route context id (typically the `X-Request-ID`) is embedded so an
 * operator can correlate the response with server logs.
 */
export function mapUnknownRouteError(
   err: unknown,
   options: MapUnknownRouteErrorOptions = {}
): RouteSafeErrorResult {
   const { requestId, includeDebug = false } = options;

   const fromErr = err as {
      statusCode?: number;
      status?: number;
      message?: string;
      stack?: string;
      errorCode?: ErrorCodeType;
   };

   const statusCode =
      typeof fromErr?.statusCode === 'number'
         ? fromErr.statusCode
         : typeof fromErr?.status === 'number'
            ? fromErr.status
            : 500;

   const message = includeDebug
      ? fromErr?.message || 'Something went wrong'
      : 'Internal server error';

   const body: RouteSafeErrorEnvelope = {
      success: false,
      code: fromErr?.errorCode || ErrorCode.INTERNAL_ERROR,
      message,
   };

   if (requestId) {
      body.requestId = requestId;
   }

   if (includeDebug) {
      if (fromErr?.stack) body.stack = fromErr.stack;
      body.error = err;
   }

   return { statusCode, body };
}
