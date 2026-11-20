/**
 * Parses a positive integer from an environment variable string.
 *
 * @param value - The string value to parse (typically from process.env)
 * @param name - The name of the environment variable (for error messages)
 * @param defaultValue - The value to return if the input is undefined
 * @returns The parsed positive integer or the default value
 * @throws Error if the value is defined but not a valid positive integer
 *
 * @example
 * const maxPageSize = parsePositiveInt(process.env.MAX_PAGE_SIZE, 'MAX_PAGE_SIZE', 100);
 */
export function parsePositiveInt(
   value: string | undefined,
   name: string,
   defaultValue: number
): number {
   if (value === undefined) {
      return defaultValue;
   }

   const trimmed = value.trim();
   if (trimmed === '') {
      throw new Error(
         `Configuration error: ${name} is defined but empty. Expected a positive integer or leave undefined to use default (${defaultValue}).`
      );
   }

   const parsed = Number(trimmed);

   if (!Number.isInteger(parsed)) {
      throw new Error(
         `Configuration error: ${name}="${value}" is not a valid integer. Expected a positive integer.`
      );
   }

   if (parsed <= 0) {
      throw new Error(
         `Configuration error: ${name}="${value}" must be a positive integer (> 0).`
      );
   }

   return parsed;
}
