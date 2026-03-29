import { z, ZodError, ZodTypeAny } from 'zod';

export type PublicQueryValidationDetail = {
   field: string;
   message: string;
};

export type PublicQueryParseResult<T> =
   | { ok: true; data: T }
   | { ok: false; details: PublicQueryValidationDetail[] };

/**
 * Parse and validate public endpoint query params with a predictable output shape.
 *
 * This helper is intentionally small and focused:
 * - maps `ZodError` into `{ field, message }[]` for API validation responses
 * - does not add runtime behavior beyond schema parsing and error shaping
 */
export function parsePublicQuery<S extends ZodTypeAny>(
   schema: S,
   rawQuery: unknown
): PublicQueryParseResult<z.infer<S>> {
   try {
      return { ok: true, data: schema.parse(rawQuery) };
   } catch (error) {
      if (error instanceof ZodError) {
         const details: PublicQueryValidationDetail[] = error.errors.map(err => ({
            field: err.path.join('.'),
            message: err.message,
         }));
         return { ok: false, details };
      }
      throw error;
   }
}

