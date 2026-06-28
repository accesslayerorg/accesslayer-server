type QueryParamType = 'string' | 'number' | 'boolean';

type QueryParamReturn<T extends QueryParamType, D> = D extends undefined
  ? T extends 'string'
    ? string | undefined
    : T extends 'number'
    ? number | undefined
    : boolean | undefined
  : T extends 'string'
  ? string
  : T extends 'number'
  ? number
  : boolean;

/**
 * Safely reads a typed value from an Express query-param map.
 *
 * - 'string': returns the raw value as-is, or defaultValue when missing.
 * - 'number': parses as integer; returns defaultValue when missing, NaN, or negative.
 * - 'boolean': accepts only 'true'/'false' strings (case-insensitive);
 *              returns defaultValue for anything else or when missing.
 */
export function readQueryParam<T extends QueryParamType, D extends QueryParamReturn<T, undefined> | undefined>(
  params: Record<string, unknown>,
  key: string,
  type: T,
  defaultValue: D
): QueryParamReturn<T, D> {
  const raw = params[key];

  if (raw === undefined || raw === null || raw === '') {
    return defaultValue as QueryParamReturn<T, D>;
  }

  const value = Array.isArray(raw) ? raw[0] : String(raw);

  if (type === 'string') {
    return value as QueryParamReturn<T, D>;
  }

  if (type === 'number') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
      return defaultValue as QueryParamReturn<T, D>;
    }
    return parsed as QueryParamReturn<T, D>;
  }

  // boolean
  const lower = value.toLowerCase();
  if (lower === 'true') return true as QueryParamReturn<T, D>;
  if (lower === 'false') return false as QueryParamReturn<T, D>;
  return defaultValue as QueryParamReturn<T, D>;
}
