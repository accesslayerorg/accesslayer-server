// src/utils/test/query-normalization-debug.utils.test.ts
// Unit tests for query normalization debug helper.

import {
   emitQueryNormalizationDebug,
   createQueryDebugEmitter,
} from '../query-normalization-debug.utils';
import { logger } from '../logger.utils';

// Mock logger to capture debug calls
const originalDebug = logger.debug;
const originalIsLevelEnabled = logger.isLevelEnabled;
let debugCalls: any[] = [];

function mockLogger(debugEnabled: boolean) {
   debugCalls = [];
   logger.isLevelEnabled = (level: string) => {
      if (level === 'debug') return debugEnabled;
      return originalIsLevelEnabled.call(logger, level);
   };
   logger.debug = (obj: any) => {
      debugCalls.push(obj);
   };
}

function restoreLogger() {
   logger.debug = originalDebug;
   logger.isLevelEnabled = originalIsLevelEnabled;
}

function assertEqual(actual: any, expected: any, message: string) {
   if (actual !== expected) {
      throw new Error(`${message}: expected ${expected}, got ${actual}`);
   }
}

function assertOk(value: any, message: string) {
   if (!value) {
      throw new Error(message);
   }
}

function run() {
   console.log('Running query-normalization-debug.utils tests...');

   // Test 1: Debug logs are emitted when debug level is enabled
   {
      mockLogger(true);
      emitQueryNormalizationDebug({
         raw: { limit: '10', offset: '0' },
         normalized: { limit: 10, offset: 0 },
         valid: true,
         context: 'test-query',
      });

      assertEqual(debugCalls.length, 1, 'Should emit one debug log');
      assertEqual(
         debugCalls[0].msg,
         'Query normalization debug snapshot',
         'Should have correct message'
      );
      assertOk(
         debugCalls[0].queryNormalization,
         'Should include queryNormalization data'
      );
      assertEqual(
         debugCalls[0].queryNormalization.context,
         'test-query',
         'Should include context'
      );
      assertEqual(
         debugCalls[0].queryNormalization.valid,
         true,
         'Should include valid flag'
      );
      restoreLogger();
   }

   // Test 2: Debug logs are NOT emitted when debug level is disabled
   {
      mockLogger(false);
      emitQueryNormalizationDebug({
         raw: { limit: '10' },
         normalized: { limit: 10 },
         valid: true,
      });

      assertEqual(
         debugCalls.length,
         0,
         'Should not emit debug logs when debug level is disabled'
      );
      restoreLogger();
   }

   // Test 3: Sensitive fields are sanitized
   {
      mockLogger(true);
      emitQueryNormalizationDebug({
         raw: {
            username: 'alice',
            password: 'secret123',
            email: 'alice@example.com',
            token: 'abc123',
         },
         normalized: {
            username: 'alice',
            password: 'secret123',
            email: 'alice@example.com',
         },
         valid: true,
         context: 'auth-query',
      });

      const snapshot = debugCalls[0].queryNormalization;
      assertEqual(
         snapshot.raw.password,
         '[REDACTED]',
         'Password should be sanitized in raw'
      );
      assertEqual(
         snapshot.raw.email,
         '[REDACTED]',
         'Email should be sanitized in raw'
      );
      assertEqual(
         snapshot.raw.token,
         '[REDACTED]',
         'Token should be sanitized in raw'
      );
      assertEqual(
         snapshot.raw.username,
         'alice',
         'Non-sensitive field should not be sanitized'
      );
      assertEqual(
         snapshot.normalized.password,
         '[REDACTED]',
         'Password should be sanitized in normalized'
      );
      restoreLogger();
   }

   // Test 4: Nested objects are sanitized recursively
   {
      mockLogger(true);
      emitQueryNormalizationDebug({
         raw: {
            user: {
               name: 'alice',
               password: 'secret',
               settings: {
                  apiKey: 'key123',
                  theme: 'dark',
               },
            },
         },
         normalized: null,
         valid: false,
      });

      const snapshot = debugCalls[0].queryNormalization;
      assertEqual(
         snapshot.raw.user.password,
         '[REDACTED]',
         'Nested password should be sanitized'
      );
      assertEqual(
         snapshot.raw.user.settings.apiKey,
         '[REDACTED]',
         'Nested API key should be sanitized'
      );
      assertEqual(
         snapshot.raw.user.name,
         'alice',
         'Nested non-sensitive field should not be sanitized'
      );
      assertEqual(
         snapshot.raw.user.settings.theme,
         'dark',
         'Nested non-sensitive field should not be sanitized'
      );
      restoreLogger();
   }

   // Test 5: Arrays are sanitized recursively
   {
      mockLogger(true);
      emitQueryNormalizationDebug({
         raw: {
            users: [
               { name: 'alice', password: 'secret1' },
               { name: 'bob', password: 'secret2' },
            ],
         },
         normalized: null,
         valid: false,
      });

      const snapshot = debugCalls[0].queryNormalization;
      assertEqual(
         snapshot.raw.users[0].password,
         '[REDACTED]',
         'Array item password should be sanitized'
      );
      assertEqual(
         snapshot.raw.users[1].password,
         '[REDACTED]',
         'Array item password should be sanitized'
      );
      assertEqual(
         snapshot.raw.users[0].name,
         'alice',
         'Array item non-sensitive field should not be sanitized'
      );
      restoreLogger();
   }

   // Test 6: Validation errors are included
   {
      mockLogger(true);
      emitQueryNormalizationDebug({
         raw: { limit: 'invalid' },
         normalized: null,
         valid: false,
         errors: [
            { field: 'limit', message: 'Expected number, received string' },
         ],
         context: 'invalid-query',
      });

      const snapshot = debugCalls[0].queryNormalization;
      assertEqual(snapshot.valid, false, 'Should mark as invalid');
      assertOk(snapshot.errors, 'Should include errors');
      assertEqual(snapshot.errors.length, 1, 'Should have one error');
      assertEqual(snapshot.errors[0].field, 'limit', 'Should include error field');
      assertEqual(
         snapshot.errors[0].message,
         'Expected number, received string',
         'Should include error message'
      );
      restoreLogger();
   }

   // Test 7: Timestamp is added automatically
   {
      mockLogger(true);
      const beforeTime = new Date().toISOString();
      emitQueryNormalizationDebug({
         raw: { test: 'value' },
         normalized: { test: 'value' },
         valid: true,
      });
      const afterTime = new Date().toISOString();

      const snapshot = debugCalls[0].queryNormalization;
      assertOk(snapshot.timestamp, 'Should include timestamp');
      assertOk(
         snapshot.timestamp >= beforeTime && snapshot.timestamp <= afterTime,
         'Timestamp should be within test execution time'
      );
      restoreLogger();
   }

   // Test 8: createQueryDebugEmitter creates a reusable emitter with fixed context
   {
      mockLogger(true);
      const debugCreatorQuery = createQueryDebugEmitter('creator-list');

      debugCreatorQuery({
         raw: { limit: '20' },
         normalized: { limit: 20 },
         valid: true,
      });

      assertEqual(debugCalls.length, 1, 'Should emit one debug log');
      assertEqual(
         debugCalls[0].queryNormalization.context,
         'creator-list',
         'Should use fixed context'
      );
      restoreLogger();
   }

   // Test 9: Case-insensitive sensitive field detection
   {
      mockLogger(true);
      emitQueryNormalizationDebug({
         raw: {
            PASSWORD: 'secret',
            Auth_Token: 'token123',
            user_email: 'test@example.com',
         },
         normalized: null,
         valid: false,
      });

      const snapshot = debugCalls[0].queryNormalization;
      assertEqual(
         snapshot.raw.PASSWORD,
         '[REDACTED]',
         'Uppercase PASSWORD should be sanitized'
      );
      assertEqual(
         snapshot.raw.Auth_Token,
         '[REDACTED]',
         'Mixed case Auth_Token should be sanitized'
      );
      assertEqual(
         snapshot.raw.user_email,
         '[REDACTED]',
         'Field containing email should be sanitized'
      );
      restoreLogger();
   }

   // Test 10: Null and undefined values are handled correctly
   {
      mockLogger(true);
      emitQueryNormalizationDebug({
         raw: { field1: null, field2: undefined, field3: 'value' },
         normalized: { field1: null, field2: undefined },
         valid: true,
      });

      const snapshot = debugCalls[0].queryNormalization;
      assertEqual(snapshot.raw.field1, null, 'Null should be preserved');
      assertEqual(
         snapshot.raw.field2,
         undefined,
         'Undefined should be preserved'
      );
      assertEqual(snapshot.raw.field3, 'value', 'String value should be preserved');
      restoreLogger();
   }

   console.log('✓ All query-normalization-debug.utils tests passed');
}

run();
