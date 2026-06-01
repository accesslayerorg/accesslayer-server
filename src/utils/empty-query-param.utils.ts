/**
 * Normalize empty query-string values before schema validation.
 *
 * Express represents `?search=` as `{ search: '' }`, while an omitted query
 * parameter is absent from `req.query`. Public query schemas should receive
 * both forms identically so optional defaults and filters behave consistently.
 */
export function coerceEmptyStringQueryParamsToUndefined(
   value: unknown
): unknown {
   if (value === '') {
      return undefined;
   }

   if (Array.isArray(value)) {
      const normalizedItems = value
         .map(item => coerceEmptyStringQueryParamsToUndefined(item))
         .filter(item => item !== undefined);

      return normalizedItems.length > 0 ? normalizedItems : undefined;
   }

   if (isQueryParamRecord(value)) {
      const normalizedEntries = Object.entries(value).flatMap(([key, item]) => {
         const normalizedValue = coerceEmptyStringQueryParamsToUndefined(item);
         return normalizedValue === undefined ? [] : [[key, normalizedValue]];
      });

      return Object.fromEntries(normalizedEntries);
   }

   return value;
}

function isQueryParamRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === 'object' && value !== null && !Array.isArray(value);
}
