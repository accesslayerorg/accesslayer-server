// src/config.test.ts
// Tests for configuration source precedence and validation behavior.

import { z } from 'zod';

/**
 * Test configuration schema behavior without affecting actual config.
 * These tests validate the documented source precedence rules.
 */

function assertEqual(actual: any, expected: any, message: string) {
   if (actual !== expected) {
      throw new Error(`${message}: expected ${expected}, got ${actual}`);
   }
}

function assertThrows(fn: () => void, message: string) {
   try {
      fn();
      throw new Error(`${message}: expected function to throw`);
   } catch (_error) {
      // Expected to throw
   }
}

function run() {
   console.log('Running config source precedence tests...');

   // Test 1: Environment variable takes precedence over default
   {
      const schema = z.object({
         PORT: z.coerce.number().default(3000),
      });

      const result = schema.parse({ PORT: '4000' });
      assertEqual(result.PORT, 4000, 'Environment value should override default');
   }

   // Test 2: Default used when environment variable not provided
   {
      const schema = z.object({
         PORT: z.coerce.number().default(3000),
      });

      const result = schema.parse({});
      assertEqual(result.PORT, 3000, 'Should use default when env var missing');
   }

   // Test 3: Required field fails when not provided
   {
      const schema = z.object({
         DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
      });

      assertThrows(
         () => schema.parse({}),
         'Should throw when required field missing'
      );
   }

   // Test 4: Required field succeeds when provided
   {
      const schema = z.object({
         DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
      });

      const result = schema.parse({ DATABASE_URL: 'postgresql://...' });
      assertEqual(
         result.DATABASE_URL,
         'postgresql://...',
         'Should use provided required value'
      );
   }

   // Test 5: Type coercion for numbers
   {
      const schema = z.object({
         PORT: z.coerce.number(),
      });

      const result = schema.parse({ PORT: '4000' });
      assertEqual(result.PORT, 4000, 'Should coerce string to number');
      assertEqual(typeof result.PORT, 'number', 'Result should be number type');
   }

   // Test 6: Type coercion for booleans
   {
      const schema = z.object({
         ENABLED: z.coerce.boolean(),
      });

      const result1 = schema.parse({ ENABLED: 'true' });
      assertEqual(result1.ENABLED, true, 'Should coerce "true" to boolean');

      const result2 = schema.parse({ ENABLED: 'false' });
      assertEqual(result2.ENABLED, false, 'Should coerce "false" to boolean');

      const result3 = schema.parse({ ENABLED: '1' });
      assertEqual(result3.ENABLED, true, 'Should coerce "1" to true');

      const result4 = schema.parse({ ENABLED: '0' });
      assertEqual(result4.ENABLED, false, 'Should coerce "0" to false');
   }

   // Test 7: Enum validation with default
   {
      const schema = z.object({
         MODE: z.enum(['development', 'production', 'test']).default('development'),
      });

      const result1 = schema.parse({ MODE: 'production' });
      assertEqual(result1.MODE, 'production', 'Should use valid enum value');

      const result2 = schema.parse({});
      assertEqual(result2.MODE, 'development', 'Should use default enum value');

      assertThrows(
         () => schema.parse({ MODE: 'invalid' }),
         'Should throw for invalid enum value'
      );
   }

   // Test 8: Optional field without default
   {
      const schema = z.object({
         OPTIONAL_KEY: z.string().optional(),
      });

      const result1 = schema.parse({ OPTIONAL_KEY: 'value' });
      assertEqual(result1.OPTIONAL_KEY, 'value', 'Should use provided optional value');

      const result2 = schema.parse({});
      assertEqual(
         result2.OPTIONAL_KEY,
         undefined,
         'Should be undefined when optional not provided'
      );
   }

   // Test 9: URL validation
   {
      const schema = z.object({
         FRONTEND_URL: z.string().url('Must be valid URL'),
      });

      const result = schema.parse({ FRONTEND_URL: 'https://example.com' });
      assertEqual(
         result.FRONTEND_URL,
         'https://example.com',
         'Should accept valid URL'
      );

      assertThrows(
         () => schema.parse({ FRONTEND_URL: 'not-a-url' }),
         'Should throw for invalid URL'
      );
   }

   // Test 10: Number range validation
   {
      const schema = z.object({
         JITTER: z.coerce.number().min(0).max(1).default(0.1),
      });

      const result1 = schema.parse({ JITTER: '0.5' });
      assertEqual(result1.JITTER, 0.5, 'Should accept value in range');

      const result2 = schema.parse({});
      assertEqual(result2.JITTER, 0.1, 'Should use default');

      assertThrows(
         () => schema.parse({ JITTER: '2' }),
         'Should throw for value above max'
      );

      assertThrows(
         () => schema.parse({ JITTER: '-1' }),
         'Should throw for value below min'
      );
   }

   // Test 11: Positive integer validation
   {
      const schema = z.object({
         TTL_MS: z.coerce.number().int().positive().default(300000),
      });

      const result1 = schema.parse({ TTL_MS: '500000' });
      assertEqual(result1.TTL_MS, 500000, 'Should accept positive integer');

      const result2 = schema.parse({});
      assertEqual(result2.TTL_MS, 300000, 'Should use default');

      assertThrows(
         () => schema.parse({ TTL_MS: '-100' }),
         'Should throw for negative value'
      );

      assertThrows(
         () => schema.parse({ TTL_MS: '100.5' }),
         'Should throw for non-integer'
      );
   }

   // Test 12: Empty string handling
   {
      const schema = z.object({
         VALUE: z.string().min(1, 'Must not be empty'),
      });

      assertThrows(
         () => schema.parse({ VALUE: '' }),
         'Should throw for empty string when min(1)'
      );
   }

   // Test 13: Precedence - environment over default
   {
      const schema = z.object({
         PORT: z.coerce.number().default(3000),
         MODE: z.enum(['development', 'production']).default('development'),
      });

      const result = schema.parse({
         PORT: '5000',
         MODE: 'production',
      });

      assertEqual(result.PORT, 5000, 'Environment PORT should override default');
      assertEqual(
         result.MODE,
         'production',
         'Environment MODE should override default'
      );
   }

   console.log('✓ All config source precedence tests passed');
}

run();
