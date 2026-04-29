// src/utils/bigint-serializer.utils.ts

/**
 * JSON replacer that converts BigInt values to strings.
 *
 * Use this wherever `JSON.stringify` may encounter BigInt values to prevent
 * a `TypeError: Do not know how to serialize a BigInt` runtime failure.
 *
 * Numeric formatting is kept explicit: BigInt values become decimal strings
 * (e.g. `9007199254740993n` → `"9007199254740993"`).
 *
 * @example
 * JSON.stringify({ id: 9007199254740993n }, bigIntReplacer);
 * // → '{"id":"9007199254740993"}'
 */
export function bigIntReplacer(_key: string, value: unknown): unknown {
   return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Safely serializes a value to a JSON string, handling BigInt values.
 *
 * Combines `bigIntReplacer` with an optional `space` argument for
 * pretty-printing. Prefer this over raw `JSON.stringify` when the
 * payload may contain BigInt fields (e.g. blockchain IDs, ledger amounts).
 *
 * @param value - The value to serialize.
 * @param space - Optional indentation (passed to `JSON.stringify`).
 *
 * @example
 * safeJsonStringify({ amount: 1000000000000000000n });
 * // → '{"amount":"1000000000000000000"}'
 */
export function safeJsonStringify(value: unknown, space?: number): string {
   return JSON.stringify(value, bigIntReplacer, space);
}

/**
 * Recursively replaces BigInt values in an object with their decimal string
 * representation. Useful when you need a plain object (not a JSON string)
 * with BigInts already coerced — e.g. before handing data to a logger or
 * a third-party serializer that doesn't accept a replacer.
 *
 * @example
 * sanitizeBigInts({ id: 1n, nested: { amount: 500n } });
 * // → { id: "1", nested: { amount: "500" } }
 */
export function sanitizeBigInts(value: unknown): unknown {
   if (typeof value === 'bigint') return value.toString();
   if (Array.isArray(value)) return value.map(sanitizeBigInts);
   if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
         Object.entries(value as Record<string, unknown>).map(([k, v]) => [
            k,
            sanitizeBigInts(v),
         ])
      );
   }
   return value;
}
