/**
 * Helper for normalizing boolean string values from environment configuration.
 *
 * Environment variables for boolean flags may arrive as "true", "false", "1",
 * "0", "yes", or "no" depending on the deployment environment. This helper
 * converts those variants into a real boolean and rejects everything else.
 *
 * Accepted true variants:  "true" | "1" | "yes"
 * Accepted false variants: "false" | "0" | "no"
 * Unrecognized values throw an EnvBooleanParseError.
 */

const TRUE_VALUES = new Set(['true', '1', 'yes']);
const FALSE_VALUES = new Set(['false', '0', 'no']);

export class EnvBooleanParseError extends Error {
  public readonly varName: string;
  public readonly rawValue: string;

  constructor(varName: string, rawValue: string) {
    super(
      `Cannot parse env var "${varName}" as boolean: received "${rawValue}". ` +
        `Accepted values: "true", "false", "1", "0", "yes", "no".`
    );
    this.name = 'EnvBooleanParseError';
    this.varName = varName;
    this.rawValue = rawValue;
  }
}

/**
 * Normalize a raw environment variable string value to a boolean.
 *
 * @param varName - The env var name, used in error messages
 * @param value   - The raw string value read from the environment
 * @returns `true` or `false`
 * @throws {EnvBooleanParseError} when the value is not a recognized boolean string
 */
export function normalizeEnvBoolean(varName: string, value: string): boolean {
  const normalized = value.trim().toLowerCase();

  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;

  throw new EnvBooleanParseError(varName, value);
}
