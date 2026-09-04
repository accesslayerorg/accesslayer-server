import { NextFunction, Request, Response } from 'express';
import { envConfig } from '../config';
import { ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { ErrorCode, ErrorCodeType } from '../constants/error.constants';
import { logger } from '../utils/logger.utils';
import { RpcTimeoutError } from '../utils/rpc-timeout.utils';
import { mapUnknownRouteError } from '../utils/route-error.utils';
import { buildErrorContext } from '../utils/error-context.utils';
import { sanitizeLogFieldValue } from '../utils/log-field-sanitizer.utils';
import {
   buildErrorResponse,
   zodIssuesToDetails,
} from '../utils/api-response.utils';

export class ApiError extends Error {
   statusCode: number;
   isOperational: boolean;
   errorCode?: ErrorCodeType;

   constructor(
      statusCode: number,
      message: string,
      errorCode?: ErrorCodeType,
      isOperational = true
   ) {
      super(message);
      this.statusCode = statusCode;
      this.errorCode = errorCode;
      this.isOperational = isOperational;
      Error.captureStackTrace(this, this.constructor);
   }
}

export const notFoundHandler = (
   req: Request,
   _res: Response,
   next: NextFunction
) => {
   const error = new ApiError(
      404,
      `Route not found: ${req.method} ${req.originalUrl}`
   );
   next(error);
};

export const temporarilyDisabled = (
   _req: Request,
   _res: Response,
   next: NextFunction
) => {
   const error = new ApiError(503, `This endpoint is temporarily disabled`);
   next(error);
};

const isCreatorListTimeout = (
   err: unknown,
   req: Request
): err is RpcTimeoutError => {
   return (
      err instanceof RpcTimeoutError &&
      req.method === 'GET' &&
      req.path === '/api/v1/creators'
   );
};

// Improved global error handling middleware
export const errorHandler: ErrorRequestHandler = (
   err: any,
   req: Request,
   res: Response,
   _next: NextFunction
): void => {
   // Log a consistent, structured error context (request id + normalized code
   // together) so failures can be correlated with the response envelope. Stack
   // traces are only attached in development builds.
   logger.error(
      {
         ...buildErrorContext(err, {
            requestId: req.requestId,
            includeStack: envConfig.MODE === 'development',
         }),
         route: `${req.method} ${sanitizeLogFieldValue(req.originalUrl)}`,
      },
      'Error caught by global handler'
   );

   if (isCreatorListTimeout(err, req)) {
      logger.warn({
         msg: 'Creator list request timed out',
         requestId: req.requestId,
         route: `${req.method} ${req.originalUrl}`,
         queryParams: req.query,
         elapsedMs: err.timeoutMs,
         timeoutMs: err.timeoutMs,
      });
   }

   // Handle Zod validation errors
   if (err instanceof z.ZodError || err.name === 'ZodError') {
      const issues: z.ZodIssue[] = err.errors ?? err.issues ?? [];
      res.status(400).json(
         buildErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            'Validation failed',
            zodIssuesToDetails(issues)
         )
      );
      return;
   }

   // Handle JWT errors
   if (err.name === 'JsonWebTokenError') {
      logger.warn({
         msg: 'Auth token validation failed',
         reason: err.message,
         route: `${req.method} ${sanitizeLogFieldValue(req.originalUrl)}`,
         requestId: req.requestId,
      });
      res.status(401).json(
         buildErrorResponse(ErrorCode.JWT_ERROR, 'Invalid or expired token')
      );
      return;
   }

   if (err.name === 'TokenExpiredError') {
      logger.warn({
         msg: 'Auth token validation failed',
         reason: 'Token has expired',
         route: `${req.method} ${sanitizeLogFieldValue(req.originalUrl)}`,
         requestId: req.requestId,
      });
      res.status(401).json(
         buildErrorResponse(ErrorCode.JWT_ERROR, 'Token has expired')
      );
      return;
   }

   // Handle Prisma errors
   if (err.code && err.code.startsWith('P')) {
      let message = 'Database operation failed';

      // Common Prisma error codes
      switch (err.code) {
         case 'P2002':
            message = 'Record already exists (unique constraint violation)';
            break;
         case 'P2025':
            message = 'Record not found';
            break;
         case 'P2003':
            message = 'Foreign key constraint violation';
            break;
      }

      res.status(400).json(
         buildErrorResponse(
            ErrorCode.PRISMA_ERROR,
            message,
            envConfig.MODE === 'development'
               ? [{ message: err.message }]
               : undefined
         )
      );
      return;
   }

   // Handle custom API errors
   if (err instanceof ApiError) {
      res.status(err.statusCode).json(
         buildErrorResponse(
            err.errorCode || ErrorCode.INTERNAL_ERROR,
            err.message
         )
      );
      return;
   }

   // Handle oversized request payload (413)
   if (
      err.type === 'entity.too.large' ||
      err.status === 413 ||
      err.statusCode === 413
   ) {
      logger.warn({
         msg: 'Request payload too large',
         route: `${req.method} ${sanitizeLogFieldValue(req.originalUrl)}`,
         contentLength: req.headers['content-length'],
         limitBytes: err.limit,
      });
      res.status(413).json(
         buildErrorResponse(ErrorCode.BAD_REQUEST, 'Request payload too large')
      );
      return;
   }

   // Handle syntax errors (malformed JSON)
   if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json(
         buildErrorResponse(ErrorCode.BAD_REQUEST, 'Invalid JSON format')
      );
      return;
   }

   // Log request details for debugging
   const { hostname, originalUrl, protocol, method } = req;
   logger.error(
      {
         requestId: req.requestId,
         method,
         url: `${protocol}://${hostname}:${envConfig.PORT || 3000}${originalUrl}`,
      },
      'Unhandled route error'
   );

   // Default fallback for unknown errors — delegated to a shared helper so
   // route-safe envelopes stay consistent and include the request id for
   // correlation. Known-error branches above handle their own mappings.
   const { statusCode, body } = mapUnknownRouteError(err, {
      requestId: req.requestId,
      includeDebug: envConfig.MODE === 'development',
   });
   res.status(statusCode).json(body);
};

// Helper functions for common errors
export const notFoundError = (resource: string) => {
   return new ApiError(404, `${resource} not found`, ErrorCode.NOT_FOUND);
};

export const badRequestError = (message: string) => {
   return new ApiError(400, message, ErrorCode.BAD_REQUEST);
};

export const unauthorizedError = (message = 'Unauthorized access') => {
   return new ApiError(401, message, ErrorCode.UNAUTHORIZED);
};

export const forbiddenError = (message = 'Access forbidden') => {
   return new ApiError(403, message, ErrorCode.FORBIDDEN);
};

export const conflictError = (message: string) => {
   return new ApiError(409, message, ErrorCode.CONFLICT);
};

export const validationError = (message: string) => {
   return new ApiError(400, message, ErrorCode.VALIDATION_ERROR);
};
