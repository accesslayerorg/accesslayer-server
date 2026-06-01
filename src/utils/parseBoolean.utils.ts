/**
 * Reusable parser for boolean-like query flags.
 *
 * Query strings arrive as strings, so this utility normalizes accepted flag
 * forms into a real boolean and rejects everything else.
 *
 * Supported true variants: "true" | "1"
 * Supported false variants: "false" | "0"
 * Absent value (undefined/null): returns null
 * Any other value: throws ParseBooleanError
 */

const TRUE_VALUES = new Set(['true', '1']);
const FALSE_VALUES = new Set(['false', '0']);

export class ParseBooleanError extends Error {
  public readonly rawValue: string;
  public readonly paramName: string;

  constructor(paramName: string, rawValue: string) {
    super(
      `Invalid boolean value for query parameter "${paramName}": received "${rawValue}". ` +
        `Accepted values: "true", "false", "1", "0".`
    );
    this.name = 'ParseBooleanError';
    this.rawValue = rawValue;
    this.paramName = paramName;
  }
}

/**
 * Parses a raw query string value into a boolean.
 *
 * @param paramName - Name of the query parameter (used in error messages)
 * @param raw - The raw value from `req.query[paramName]`
 * @returns `true`, `false`, or `null` when the parameter is absent
 * @throws {ParseBooleanError} when the value is present but unrecognized
 */
export function parseBoolean(
  paramName: string,
  raw: string | string[] | boolean | null | undefined
): boolean | null {
  if (raw === undefined || raw === null) {
    return null;
  }

  if (typeof raw === 'boolean') {
    return raw;
  }

  const rawValue = Array.isArray(raw) ? raw[0] : raw;
  if (typeof rawValue !== 'string') {
    throw new ParseBooleanError(paramName, String(rawValue));
  }

  const value = rawValue.trim().toLowerCase();

  if (TRUE_VALUES.has(value)) {
    return true;
  }

  if (FALSE_VALUES.has(value)) {
    return false;
  }

  throw new ParseBooleanError(paramName, rawValue);
}

/**
 * Same as `parseBoolean` but returns a caller-supplied default when the
 * parameter is absent instead of null.
 */
export function parseBooleanWithDefault(
  paramName: string,
  raw: string | string[] | boolean | null | undefined,
  defaultValue: boolean
): boolean {
  const result = parseBoolean(paramName, raw);
  return result === null ? defaultValue : result;
}
