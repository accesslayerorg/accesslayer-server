// src/utils/comma-query.utils.ts
// Reusable parser for comma-separated query string values.
// Handles trimming, deduplication, and empty-value filtering consistently
// so every list/filter endpoint behaves the same way.

/**
 * Parse a query parameter that may contain comma-separated values.
 *
 * Accepts:
 *  - a plain string: `"a,b, c"` → `["a", "b", "c"]`
 *  - an array of strings (Express req.query can return string[]): flattened then split
 *  - undefined / null → `[]`
 *
 * Processing order:
 *  1. Accept string | string[] | undefined | null
 *  2. Join arrays with ","
 *  3. Split on ","
 *  4. Trim each token
 *  5. Drop empty tokens
 *  6. Deduplicate (preserve first-occurrence order)
 *
 * @param raw - Raw query param value from req.query
 * @returns Ordered, deduplicated array of non-empty trimmed strings
 *
 * @example
 * parseCommaQuery("a,b, c")         // ["a", "b", "c"]
 * parseCommaQuery(["a,b", "c"])     // ["a", "b", "c"]
 * parseCommaQuery("a,,b, ,c,a")     // ["a", "b", "c"]  (deduped + empty dropped)
 * parseCommaQuery(undefined)        // []
 */
export function parseCommaQuery(
  raw: string | string[] | undefined | null
): string[] {
  if (raw == null) return [];

  const joined = Array.isArray(raw) ? raw.join(',') : raw;

  const seen = new Set<string>();
  const result: string[] = [];

  for (const token of joined.split(',')) {
    const trimmed = token.trim();
    if (trimmed === '') continue;
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }

  return result;
}
