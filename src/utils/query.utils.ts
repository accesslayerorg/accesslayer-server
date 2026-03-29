import { z } from 'zod';

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
