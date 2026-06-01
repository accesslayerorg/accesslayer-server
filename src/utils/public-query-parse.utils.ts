import { z, ZodError, ZodTypeAny } from 'zod';
import { emitQueryNormalizationDebug } from './query-normalization-debug.utils';
import { coerceEmptyStringQueryParamsToUndefined } from './empty-query-param.utils';

export type PublicQueryValidationDetail = {
   field: string;
   message: string;
};

export type PublicQueryParseResult<T> =
   | { ok: true; data: T }
   | { ok: false; details: PublicQueryValidationDetail[] };

export interface ParsePublicQueryOptions {
   /**
    * Optional context label for debug logging.
    * When provided, emits a debug snapshot of the query normalization.
    * Only active when logger is set to debug level.
    */
   debugContext?: string;
}

/**
 * Parse and validate public endpoint query params with a predictable output shape.
 *
 * This helper is intentionally small and focused:
 * - maps `ZodError` into `{ field, message }[]` for API validation responses
 * - coerces empty-string query params to omitted values before validation
 * - optionally emits debug snapshots when debugContext is provided (debug level only)
 */
export function parsePublicQuery<S extends ZodTypeAny>(
   schema: S,
   rawQuery: unknown,
   options?: ParsePublicQueryOptions
): PublicQueryParseResult<z.infer<S>> {
   const normalizedQuery = coerceEmptyStringQueryParamsToUndefined(rawQuery);

   try {
      const data = schema.parse(normalizedQuery);

      // Emit debug snapshot if context is provided
      if (options?.debugContext) {
         emitQueryNormalizationDebug({
            raw: rawQuery,
            normalized: data,
            valid: true,
            context: options.debugContext,
         });
      }

      return { ok: true, data };
   } catch (error) {
      if (error instanceof ZodError) {
         const details: PublicQueryValidationDetail[] = error.errors.map(
            err => ({
               field: err.path.join('.'),
               message: err.message,
            })
         );

         // Emit debug snapshot if context is provided
         if (options?.debugContext) {
            emitQueryNormalizationDebug({
               raw: rawQuery,
               normalized: null,
               valid: false,
               errors: details,
               context: options.debugContext,
            });
         }

         return { ok: false, details };
      }
      throw error;
   }
}
