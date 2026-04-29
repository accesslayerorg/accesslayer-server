// src/middlewares/schema-version.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { envConfig } from '../config';
import { REQUEST_SCHEMA_VERSION, SCHEMA_VERSION_HEADER } from '../constants/schema.constants';

/**
 * Middleware that adds a schema version header to the response.
 *
 * This header informs the client about the expected structure of request bodies.
 *
 * Can be enabled/disabled via the `ENABLE_SCHEMA_VERSION_HEADER` environment variable.
 */
export const schemaVersionMiddleware = (
   _req: Request,
   res: Response,
   next: NextFunction
): void => {
   if (envConfig.ENABLE_SCHEMA_VERSION_HEADER) {
      res.setHeader(SCHEMA_VERSION_HEADER, REQUEST_SCHEMA_VERSION);
   }
   next();
};
