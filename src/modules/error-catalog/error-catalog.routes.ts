// src/modules/error-catalog/error-catalog.routes.ts
// Contract error catalog endpoints (#1326). Mounted at /errors.

import { Response, Router } from 'express';
import { z } from 'zod';
import { ErrorCode } from '../../constants/error.constants';
import {
   sendError,
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   decodeContractError,
   ErrorCatalogNotFoundError,
   ErrorCatalogUnavailableError,
   getErrorCatalogView,
   loadErrorCatalog,
} from './error-catalog.service';

export const errorCatalogRouter = Router();

const CONTRACT_NAME = z
   .string()
   .trim()
   .min(1)
   .max(128)
   .regex(/^[A-Za-z0-9_-]+$/, 'contract must use letters, digits, "-" or "_"');
const VERSION_ID = z.string().trim().min(1).max(128);

const catalogQuerySchema = z.object({
   contract: CONTRACT_NAME,
   version: VERSION_ID.optional(),
});

const decodeBodySchema = z
   .object({
      contract: CONTRACT_NAME.optional(),
      version: VERSION_ID.optional(),
      code: z.number().int().min(0).max(4_294_967_295).optional(),
      raw: z.string().max(4000).optional(),
   })
   .refine(body => body.code !== undefined || body.raw !== undefined, {
      message: 'Provide either code or raw',
      path: ['code'],
   });

function sendCatalogUnavailable(res: Response, message: string): void {
   sendError(res, 503, ErrorCode.SERVICE_UNAVAILABLE, message);
}

/**
 * GET /errors/catalog?contract=&version=
 * Errors for one contract version (latest when `version` is omitted). The
 * `version` value may be a catalog version id or a wasm hash. Responses carry
 * an ETag, and a matching If-None-Match returns 304.
 */
errorCatalogRouter.get('/catalog', (req, res, next) => {
   const query = catalogQuerySchema.safeParse(req.query);
   if (!query.success) {
      sendValidationError(res, 'Invalid query', zodIssuesToDetails(query.error.issues));
      return;
   }

   try {
      const { body, etag } = getErrorCatalogView(query.data);
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'public, max-age=60');
      if (req.headers['if-none-match'] === etag) {
         res.status(304).end();
         return;
      }
      sendSuccess(res, body);
   } catch (error) {
      if (error instanceof ErrorCatalogNotFoundError) {
         sendNotFound(res, 'Contract error catalog entry');
         return;
      }
      if (error instanceof ErrorCatalogUnavailableError) {
         sendCatalogUnavailable(res, error.message);
         return;
      }
      next(error);
   }
});

/**
 * POST /errors/decode
 * Body: `{ contract?, version?, code? | raw? }`. `raw` is a simulation or
 * submission failure string; the code is extracted from it. Unmatched input
 * returns `matched: false` with the generic fallback.
 */
errorCatalogRouter.post('/decode', (req, res, next) => {
   const body = decodeBodySchema.safeParse(req.body ?? {});
   if (!body.success) {
      sendValidationError(res, 'Invalid request body', zodIssuesToDetails(body.error.issues));
      return;
   }

   try {
      sendSuccess(res, decodeContractError(loadErrorCatalog(), body.data));
   } catch (error) {
      if (error instanceof ErrorCatalogUnavailableError) {
         sendCatalogUnavailable(res, error.message);
         return;
      }
      next(error);
   }
});

export default errorCatalogRouter;
