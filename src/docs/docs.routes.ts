// src/docs/docs.routes.ts
// Serves the OpenAPI document and Swagger UI (#1224).
//
// - GET /openapi.json is always served.
// - GET /docs (Swagger UI) is only mounted when `isDocsEnabled()` is true, so
//   in production it falls through to the normal 404 handler instead of being
//   half-mounted.
//
// Mounted under /api/v1 in app.ts.

import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiDocument } from './openapi';

/**
 * Swagger UI is on outside production. In production it requires an explicit
 * `DOCS_ENABLED=true`. Production is detected from `MODE` (this repo's
 * convention) or the standard `NODE_ENV`.
 */
export function isDocsEnabled(
   env: Record<string, string | undefined> = process.env
): boolean {
   const isProduction =
      env.NODE_ENV === 'production' || env.MODE === 'production';
   return !isProduction || env.DOCS_ENABLED === 'true';
}

export const OPENAPI_JSON_PATH = '/openapi.json';
export const DOCS_PATH = '/docs';

export function createDocsRouter(
   options: { uiEnabled?: boolean; specUrl?: string } = {}
): Router {
   const { uiEnabled = isDocsEnabled(), specUrl = '/api/v1/openapi.json' } =
      options;
   const router = Router();

   // Built once; the document is static for the life of the process.
   const document = buildOpenApiDocument();

   router.get(OPENAPI_JSON_PATH, (_req, res) => {
      res.json(document);
   });

   if (uiEnabled) {
      router.use(DOCS_PATH, swaggerUi.serve);
      router.get(
         DOCS_PATH,
         swaggerUi.setup(undefined, {
            customSiteTitle: 'Access Layer API Docs',
            swaggerOptions: { url: specUrl },
         })
      );
   }

   return router;
}
