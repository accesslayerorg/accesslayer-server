import express from 'express';
import request from 'supertest';
import { readFileSync } from 'fs';
import Validator from '@seriousme/openapi-schema-validator';
import { buildOpenApiDocument } from './openapi';
import { registry } from './registry';
import { createDocsRouter, isDocsEnabled } from './docs.routes';
import { OPENAPI_OUTPUT_PATH, serializeOpenApiDocument } from './generate';

function appWith(uiEnabled: boolean) {
   const app = express();
   app.use('/api/v1', createDocsRouter({ uiEnabled }));
   return app;
}

describe('OpenAPI document', () => {
   const document = buildOpenApiDocument();

   it('validates against the OpenAPI 3.1 schema', async () => {
      const validator = new Validator();
      const result = await validator.validate(
         JSON.parse(JSON.stringify(document))
      );
      expect(result.errors).toBeUndefined();
      expect(result.valid).toBe(true);
      expect(validator.version).toBe('3.1');
   });

   it('declares the wallet-auth security scheme', () => {
      expect(document.components?.securitySchemes?.walletAuth).toMatchObject({
         type: 'http',
         scheme: 'bearer',
      });
   });

   it('includes every registered route with request and response schemas', () => {
      const registered = registry.definitions.filter(
         d => d.type === 'route'
      ) as Array<{
         route: { method: string; path: string; request?: unknown };
      }>;
      expect(registered.length).toBeGreaterThan(0);

      for (const { route } of registered) {
         const operation = (
            document.paths as Record<string, Record<string, any>>
         )[route.path]?.[route.method];
         expect(operation).toBeDefined();

         const hasRequestInput =
            operation.requestBody !== undefined ||
            (operation.parameters ?? []).length > 0;
         expect(hasRequestInput).toBe(true);

         const successful = Object.entries(operation.responses).filter(
            ([status]) => status.startsWith('2')
         );
         expect(successful.length).toBeGreaterThan(0);
         for (const [, response] of successful as Array<[string, any]>) {
            expect(response.content['application/json'].schema).toBeDefined();
         }
      }
   });

   it('is deterministic and matches the committed docs/openapi.json', () => {
      expect(serializeOpenApiDocument()).toBe(serializeOpenApiDocument());
      expect(readFileSync(OPENAPI_OUTPUT_PATH, 'utf8')).toBe(
         serializeOpenApiDocument()
      );
   });
});

describe('docs routes', () => {
   it('serves the spec at GET /api/v1/openapi.json', async () => {
      const res = await request(appWith(false)).get('/api/v1/openapi.json');
      expect(res.status).toBe(200);
      expect(res.body.openapi).toBe('3.1.0');
   });

   it('serves Swagger UI when enabled', async () => {
      const res = await request(appWith(true)).get('/api/v1/docs/');
      expect(res.status).toBe(200);
      expect(res.text).toContain('swagger-ui');
   });

   it('returns 404 for Swagger UI when disabled', async () => {
      const res = await request(appWith(false)).get('/api/v1/docs/');
      expect(res.status).toBe(404);
   });
});

describe('isDocsEnabled', () => {
   it('is enabled outside production', () => {
      expect(isDocsEnabled({})).toBe(true);
      expect(isDocsEnabled({ MODE: 'development' })).toBe(true);
      expect(isDocsEnabled({ NODE_ENV: 'test' })).toBe(true);
   });

   it('is disabled in production unless DOCS_ENABLED=true', () => {
      expect(isDocsEnabled({ NODE_ENV: 'production' })).toBe(false);
      expect(isDocsEnabled({ MODE: 'production' })).toBe(false);
      expect(
         isDocsEnabled({ NODE_ENV: 'production', DOCS_ENABLED: 'false' })
      ).toBe(false);
      expect(
         isDocsEnabled({ NODE_ENV: 'production', DOCS_ENABLED: 'true' })
      ).toBe(true);
      expect(isDocsEnabled({ MODE: 'production', DOCS_ENABLED: 'true' })).toBe(
         true
      );
   });
});
