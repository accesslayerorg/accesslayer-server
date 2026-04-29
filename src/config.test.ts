// src/config.test.ts
// Tests for configuration source precedence and validation behavior.

import { z } from 'zod';

/**
 * Test configuration schema behavior without affecting actual config.
 * These tests validate the documented source precedence rules.
 */

const booleanCoerce = z.preprocess((val) => {
   if (typeof val === 'string') {
      const lower = val.toLowerCase();
      if (lower === 'true' || lower === '1') return true;
      if (lower === 'false' || lower === '0') return false;
   }
   return val;
}, z.coerce.boolean());

describe('Config Source Precedence', () => {
   it('Environment variable takes precedence over default', () => {
      const schema = z.object({
         PORT: z.coerce.number().default(3000),
      });

      const result = schema.parse({ PORT: '4000' });
      expect(result.PORT).toBe(4000);
   });

   it('Default used when environment variable not provided', () => {
      const schema = z.object({
         PORT: z.coerce.number().default(3000),
      });

      const result = schema.parse({});
      expect(result.PORT).toBe(3000);
   });

   it('Required field fails when not provided', () => {
      const schema = z.object({
         DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
      });

      expect(() => schema.parse({})).toThrow();
   });

   it('Required field succeeds when provided', () => {
      const schema = z.object({
         DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
      });

      const result = schema.parse({ DATABASE_URL: 'postgresql://...' });
      expect(result.DATABASE_URL).toBe('postgresql://...');
   });

   it('Type coercion for numbers', () => {
      const schema = z.object({
         PORT: z.coerce.number(),
      });

      const result = schema.parse({ PORT: '4000' });
      expect(result.PORT).toBe(4000);
      expect(typeof result.PORT).toBe('number');
   });

   it('Type coercion for booleans', () => {
      const schema = z.object({
         ENABLED: booleanCoerce,
      });

      expect(schema.parse({ ENABLED: 'true' }).ENABLED).toBe(true);
      expect(schema.parse({ ENABLED: 'false' }).ENABLED).toBe(false);
      expect(schema.parse({ ENABLED: '1' }).ENABLED).toBe(true);
      expect(schema.parse({ ENABLED: '0' }).ENABLED).toBe(false);
   });

   it('Enum validation with default', () => {
      const schema = z.object({
         MODE: z.enum(['development', 'production', 'test']).default('development'),
      });

      expect(schema.parse({ MODE: 'production' }).MODE).toBe('production');
      expect(schema.parse({}).MODE).toBe('development');
      expect(() => schema.parse({ MODE: 'invalid' })).toThrow();
   });

   it('Optional field without default', () => {
      const schema = z.object({
         OPTIONAL_KEY: z.string().optional(),
      });

      expect(schema.parse({ OPTIONAL_KEY: 'value' }).OPTIONAL_KEY).toBe('value');
      expect(schema.parse({}).OPTIONAL_KEY).toBeUndefined();
   });

   it('URL validation', () => {
      const schema = z.object({
         FRONTEND_URL: z.string().url('Must be valid URL'),
      });

      expect(schema.parse({ FRONTEND_URL: 'https://example.com' }).FRONTEND_URL).toBe(
         'https://example.com'
      );
      expect(() => schema.parse({ FRONTEND_URL: 'not-a-url' })).toThrow();
   });

   it('Number range validation', () => {
      const schema = z.object({
         JITTER: z.coerce.number().min(0).max(1).default(0.1),
      });

      expect(schema.parse({ JITTER: '0.5' }).JITTER).toBe(0.5);
      expect(schema.parse({}).JITTER).toBe(0.1);
      expect(() => schema.parse({ JITTER: '2' })).toThrow();
      expect(() => schema.parse({ JITTER: '-1' })).toThrow();
   });

   it('Positive integer validation', () => {
      const schema = z.object({
         TTL_MS: z.coerce.number().int().positive().default(300000),
      });

      expect(schema.parse({ TTL_MS: '500000' }).TTL_MS).toBe(500000);
      expect(schema.parse({}).TTL_MS).toBe(300000);
      expect(() => schema.parse({ TTL_MS: '-100' })).toThrow();
      expect(() => schema.parse({ TTL_MS: '100.5' })).toThrow();
   });

   it('Empty string handling', () => {
      const schema = z.object({
         VALUE: z.string().min(1, 'Must not be empty'),
      });

      expect(() => schema.parse({ VALUE: '' })).toThrow();
   });

   it('Precedence - environment over default', () => {
      const schema = z.object({
         PORT: z.coerce.number().default(3000),
         MODE: z.enum(['development', 'production']).default('development'),
      });

      const result = schema.parse({
         PORT: '5000',
         MODE: 'production',
      });

      expect(result.PORT).toBe(5000);
      expect(result.MODE).toBe('production');
   });
});
