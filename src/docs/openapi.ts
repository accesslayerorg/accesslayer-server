// src/docs/openapi.ts
// Assembles the OpenAPI 3.1 document from the registry (#1224).
// The output must be deterministic: no timestamps, no env-derived values.

import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { registry, TAGS } from './registry';

export function buildOpenApiDocument() {
   const generator = new OpenApiGeneratorV31(registry.definitions);

   return generator.generateDocument({
      openapi: '3.1.0',
      info: {
         title: 'Access Layer Server API',
         version: '1.0.0',
         description:
            'REST API for Access Layer, the off-chain backend for a Stellar-native creator keys marketplace.',
      },
      // Relative server URL keeps the document independent of the environment.
      servers: [{ url: '/api/v1' }],
      tags: [
         { name: TAGS.auth, description: 'Authentication and registration' },
         { name: TAGS.nonce, description: 'Wallet nonce / replay protection' },
         { name: TAGS.search, description: 'Global search' },
         { name: TAGS.creators, description: 'Creator discovery' },
      ],
   });
}
