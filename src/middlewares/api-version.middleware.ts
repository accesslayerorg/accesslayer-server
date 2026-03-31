// src/middlewares/api-version.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { envConfig } from '../config';

/**
 * Middleware that adds an `X-API-Version` header to the response.
 *
 * This header exposes the current API schema or version identifier.
 *
 * Can be enabled/disabled via the `ENABLE_API_VERSION_HEADER` environment variable.
 */
export const apiVersionMiddleware = (
   _req: Request,
   res: Response,
   next: NextFunction
): void => {
   if (envConfig.ENABLE_API_VERSION_HEADER) {
      res.setHeader('X-API-Version', envConfig.API_VERSION);
   }
   next();
};
