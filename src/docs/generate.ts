// src/docs/generate.ts
// `pnpm docs:generate` — writes the OpenAPI document to docs/openapi.json.
// Output is deterministic so CI can diff it against the committed file.

import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { buildOpenApiDocument } from './openapi';

export const OPENAPI_OUTPUT_PATH = resolve(
   __dirname,
   '../../docs/openapi.json'
);

export function serializeOpenApiDocument(): string {
   return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}

if (require.main === module) {
   mkdirSync(dirname(OPENAPI_OUTPUT_PATH), { recursive: true });
   writeFileSync(OPENAPI_OUTPUT_PATH, serializeOpenApiDocument());
   console.log(`Wrote ${OPENAPI_OUTPUT_PATH}`);
}
