import { ErrorCode, ErrorCodeType } from '../constants/error.constants';

/**
 * Structured, log-safe context extracted from a caught exception.
 *
 * Standardises the shape of error information across handlers so the request
 * id and a normalized error code can be logged together. The `stack` field is
 * debug-only and is omitted unless `includeStack` is set (production builds
 * should leave it off).
 */
export interface ErrorContext {
   name: string;
   message: string;
   code: ErrorCodeType;
   requestId?: string;
   stack?: string;
   timestamp: string;
}

export interface BuildErrorContextOptions {
   requestId?: string;
   /** Include the stack trace — intended for development/debug builds only. */
   includeStack?: boolean;
}

interface ErrorLike {
   name?: string;
   message?: string;
   stack?: string;
   code?: unknown;
   errorCode?: ErrorCodeType;
}

const KNOWN_ERROR_CODES = new Set<string>(Object.values(ErrorCode));

/**
 * Normalize a caught exception to one of the shared {@link ErrorCode} values.
 * Mirrors the classification used by the global error middleware so logs and
 * responses agree on the code.
 */
function normalizeErrorCode(err: ErrorLike): ErrorCodeType {
   if (
      typeof err.errorCode === 'string' &&
      KNOWN_ERROR_CODES.has(err.errorCode)
   ) {
      return err.errorCode;
   }

   if (typeof err.code === 'string' && err.code.startsWith('P')) {
      return ErrorCode.PRISMA_ERROR;
   }

   switch (err.name) {
      case 'ZodError':
         return ErrorCode.VALIDATION_ERROR;
      case 'JsonWebTokenError':
      case 'TokenExpiredError':
         return ErrorCode.JWT_ERROR;
      default:
         return ErrorCode.INTERNAL_ERROR;
   }
}

/**
 * Builds a consistent {@link ErrorContext} from any caught value (Error
 * subclasses, Prisma errors, plain strings, etc.).
 */
export function buildErrorContext(
   err: unknown,
   options: BuildErrorContextOptions = {}
): ErrorContext {
   const { requestId, includeStack = false } = options;
   const errLike: ErrorLike =
      typeof err === 'object' && err !== null ? (err as ErrorLike) : {};

   const name =
      errLike.name ||
      (err instanceof Error ? err.constructor.name : 'NonError');
   const message =
      errLike.message ||
      (typeof err === 'string' && err.length > 0 ? err : 'Unknown error');

   const context: ErrorContext = {
      name,
      message,
      code: normalizeErrorCode(errLike),
      timestamp: new Date().toISOString(),
   };

   if (requestId) {
      context.requestId = requestId;
   }

   if (includeStack && errLike.stack) {
      context.stack = errLike.stack;
   }

   return context;
}
