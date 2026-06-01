import { strict as assert } from 'assert';
import { schemaVersionMiddleware } from './schema-version.middleware';
import type { Request, Response, NextFunction } from 'express';
import { REQUEST_SCHEMA_VERSION, SCHEMA_VERSION_HEADER } from '../constants/schema.constants';
import { envConfig } from '../config';

// Minimal mock helpers
function mockRes() {
   const headers: Record<string, string> = {};
   return {
      headers,
      setHeader(name: string, value: string) {
         headers[name] = value;
      },
   } as unknown as Response & { headers: Record<string, string> };
}

function mockReq() {
   return {} as Request;
}

function run() {
   // sets schema version header when enabled
   {
      const res = mockRes();
      let called = false;
      const next: NextFunction = () => {
         called = true;
      };
      
      // Ensure it's enabled for the test
      const originalValue = envConfig.ENABLE_SCHEMA_VERSION_HEADER;
      (envConfig as any).ENABLE_SCHEMA_VERSION_HEADER = true;
      
      schemaVersionMiddleware(mockReq(), res, next);
      
      assert.equal(res.headers[SCHEMA_VERSION_HEADER], REQUEST_SCHEMA_VERSION);
      assert.ok(called, 'next() should be called');
      
      // Restore
      (envConfig as any).ENABLE_SCHEMA_VERSION_HEADER = originalValue;
   }

   // does not set header when disabled
   {
      const res = mockRes();
      let called = false;
      const next: NextFunction = () => {
         called = true;
      };
      
      // Ensure it's disabled for the test
      const originalValue = envConfig.ENABLE_SCHEMA_VERSION_HEADER;
      (envConfig as any).ENABLE_SCHEMA_VERSION_HEADER = false;
      
      schemaVersionMiddleware(mockReq(), res, next);
      
      assert.ok(!(SCHEMA_VERSION_HEADER in res.headers), 'Header should not be set');
      assert.ok(called, 'next() should be called');
      
      // Restore
      (envConfig as any).ENABLE_SCHEMA_VERSION_HEADER = originalValue;
   }

   console.log('schema-version.middleware tests passed');
}

run();
