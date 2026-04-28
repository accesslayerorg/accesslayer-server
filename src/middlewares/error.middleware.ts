// src/middlewares/error.middleware.ts
import { NextFunction, Request, Response } from 'express';
import { envConfig } from '../config';
import { ErrorRequestHandler } from 'express';
import chalk from 'chalk';
import { z } from 'zod';
import { ErrorCode, ErrorCodeType } from '../constants/error.constants';
import { logger } from '../utils/logger.utils';

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

// Improved global error handling middleware
export const errorHandler: ErrorRequestHandler = (
   err: any,
   req: Request,
   res: Response,
   _next: NextFunction
): void => {
   // Log error details
   console.error('🚨 Error caught by global handler:');
   console.error('URL:', req.method, req.originalUrl);
   console.error('Error:', err);

   // Handle Zod validation errors
   if (err instanceof z.ZodError || err.name === 'ZodError') {
      res.status(400).json({
         success: false,
         code: ErrorCode.VALIDATION_ERROR,
         message: 'Validation failed',
         errors: err.errors || err.issues,
      });
      return;
   }

   // Handle JWT errors
   if (err.name === 'JsonWebTokenError') {
      res.status(401).json({
         success: false,
         code: ErrorCode.JWT_ERROR,
         message: 'Invalid or expired token',
      });
      return;
   }

   if (err.name === 'TokenExpiredError') {
      res.status(401).json({
         success: false,
         code: ErrorCode.JWT_ERROR,
         message: 'Token has expired',
      });
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

      res.status(400).json({
         success: false,
         code: ErrorCode.PRISMA_ERROR,
         message,
         ...(envConfig.MODE === 'development' && { error: err.message }),
      });
      return;
   }

   // Handle custom API errors
   if (err instanceof ApiError) {
      res.status(err.statusCode).json({
         success: false,
         code: err.errorCode || ErrorCode.INTERNAL_ERROR,
         message: err.message,
      });
      return;
   }

   // Handle oversized request payload (413)
   if (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413) {
      logger.warn({
         msg: 'Request payload too large',
         route: `${req.method} ${req.originalUrl}`,
         contentLength: req.headers['content-length'],
         limitBytes: err.limit,
      });
      res.status(413).json({
         success: false,
         code: ErrorCode.BAD_REQUEST,
         message: 'Request payload too large',
      });
      return;
   }

   // Handle syntax errors (malformed JSON)
   if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({
         success: false,
         code: ErrorCode.BAD_REQUEST,
         message: 'Invalid JSON format',
      });
      return;
   }

   // Log request details for debugging
   const chalkColor = {
      error: chalk.red,
      success: chalk.green,
      getReq: chalk.magenta,
      postReq: chalk.cyan,
   };

   const { hostname, originalUrl, protocol, method } = req;
   console.log(
      chalkColor.error('❌ ERROR'),
      `${method === 'GET' ? chalkColor.getReq(method) : chalkColor.postReq(method)} ${protocol}://${hostname}:${envConfig.PORT || 3000}${originalUrl}`
   );

   // Default error response
   const statusCode = err.statusCode || err.status || 500;
   const message =
      envConfig.MODE === 'production'
         ? 'Internal server error'
         : err.message || 'Something went wrong!';

   res.status(statusCode).json({
      success: false,
      code: err.errorCode || ErrorCode.INTERNAL_ERROR,
      message,
      ...(envConfig.MODE === 'development' && {
         stack: err.stack,
         error: err,
      }),
   });
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
