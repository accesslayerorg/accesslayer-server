/**
 * parseBoolean.utils.ts
 *
 * Reusable parser for boolean query parameters across creator endpoints.
 *
 * HTTP query strings are always strings, so a value of `true` arrives as
 * the literal string "true". This utility normalises common truthy/falsy
 * variants into a proper boolean (or null when the value is absent) and
 * rejects anything that cannot be unambiguously interpreted.
 *
 * Supported true  variants : "true"  | "1" | "yes" | "on"
 * Supported false variants : "false" | "0" | "no"  | "off"
 * Absent value (undefined)  : returns null  — caller decides the default
 * Any other string          : throws ParseBooleanError (400-safe)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRUE_VALUES  = new Set(["true",  "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no",  "off"]);

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class ParseBooleanError extends Error {
  /** The raw value that could not be parsed */
  public readonly rawValue: string;
  /** The query parameter name, for clearer error messages */
  public readonly paramName: string;

  constructor(paramName: string, rawValue: string) {
    super(
      `Invalid boolean value for query parameter "${paramName}": received "${rawValue}". ` +
      `Accepted values: "true", "false", "1", "0", "yes", "no", "on", "off".`
    );
    this.name = "ParseBooleanError";
    this.rawValue = rawValue;
    this.paramName = paramName;
  }
}

// ---------------------------------------------------------------------------
// Core parser
// ---------------------------------------------------------------------------

/**
 * Parses a raw query string value into a boolean.
 *
 * @param paramName - Name of the query parameter (used in error messages)
 * @param raw       - The raw value from `req.query[paramName]`
 * @returns `true`, `false`, or `null` when the parameter is absent
 * @throws {ParseBooleanError} when the value is present but unrecognised
 *
 * @example
 * // ?isVerified=true   → true
 * // ?isVerified=0      → false
 * // ?isVerified=yes    → true
 * // ?isVerified=       → throws ParseBooleanError
 * // (param absent)     → null
 */
export function parseBoolean(
  paramName: string,
  raw: string | string[] | undefined
): boolean | null {
  // Absent parameter — caller applies its own default
  if (raw === undefined) return null;

  // Always work with a single string; ignore arrays (take the first value)
  const value = (Array.isArray(raw) ? raw[0] : raw).trim().toLowerCase();

  if (TRUE_VALUES.has(value))  return true;
  if (FALSE_VALUES.has(value)) return false;

  throw new ParseBooleanError(paramName, Array.isArray(raw) ? raw[0] : raw);
}

// ---------------------------------------------------------------------------
// Convenience wrapper with a fallback default
// ---------------------------------------------------------------------------

/**
 * Same as `parseBoolean` but returns a caller-supplied default when the
 * parameter is absent instead of null.
 *
 * @param paramName    - Name of the query parameter
 * @param raw          - The raw value from `req.query[paramName]`
 * @param defaultValue - Value to return when the parameter is absent
 *
 * @example
 * const isVerified = parseBooleanWithDefault("isVerified", req.query.isVerified, false);
 */
export function parseBooleanWithDefault(
  paramName: string,
  raw: string | string[] | undefined,
  defaultValue: boolean
): boolean {
  const result = parseBoolean(paramName, raw);
  return result === null ? defaultValue : result;
}