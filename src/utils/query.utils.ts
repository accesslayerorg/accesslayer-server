import { z } from 'zod';
import { parseBoolean, ParseBooleanError } from './parseBoolean.utils';

/**
 * Creates a Zod schema for safely parsing an integer query parameter.
 *
 * Accepts a string (as Express delivers query params), applies a default,
 * converts to integer, and validates within [min, max].
 * Non-numeric strings resolve to NaN, which fails the bounds refine.
 */
export function safeIntParam(options: {
   defaultValue: number;
   min: number;
   max: number;
   label: string;
}) {
   const { defaultValue, min, max, label } = options;

   return z
      .string()
      .optional()
      .default(String(defaultValue))
      .transform(val => parseInt(val, 10))
      .refine(val => !Number.isNaN(val) && val >= min && val <= max, {
         message: `${label} must be an integer between ${min} and ${max}`,
      });
}

/**
 * Creates a Zod schema for safely parsing a boolean-like query parameter.
 *
 * Accepts the common string flag forms supported by `parseBoolean` and maps
 * invalid values into a stable validation error message.
 */
export function safeBooleanQueryParam(options: {
   paramName: string;
   defaultValue?: boolean;
}) {
   const { paramName, defaultValue } = options;

   return z.any().optional().transform((raw, ctx) => {
      try {
         const parsed = parseBoolean(paramName, raw);
         return parsed === null ? defaultValue : parsed;
      } catch (error) {
         if (error instanceof ParseBooleanError) {
            ctx.addIssue({
               code: z.ZodIssueCode.custom,
               message: error.message,
            });
            return z.NEVER;
         }

         throw error;
      }
   });
}
