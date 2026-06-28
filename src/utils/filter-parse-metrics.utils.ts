/**
 * Lightweight in-process counter for filter parse errors.
 *
 * Tracks validation failures on creator list endpoints so operators can
 * monitor malformed or malicious query patterns without external dependencies.
 */

export type FilterParseErrorCategory = 'unknown_key' | 'invalid_value' | 'schema_error';

export interface FilterParseErrorEntry {
  route: string;
  category: FilterParseErrorCategory;
  count: number;
  lastOccurred: string;
}

const counters = new Map<string, FilterParseErrorEntry>();

function key(route: string, category: FilterParseErrorCategory): string {
  return `${route}:${category}`;
}

/**
 * Increment the error counter for a specific route and error category.
 *
 * @param route - The API route where the error occurred (e.g., '/api/v1/creators')
 * @param category - The type of parse error
 */
export function incrementFilterParseError(
  route: string,
  category: FilterParseErrorCategory
): void {
  const k = key(route, category);
  const existing = counters.get(k);
  if (existing) {
    existing.count += 1;
    existing.lastOccurred = new Date().toISOString();
  } else {
    counters.set(k, {
      route,
      category,
      count: 1,
      lastOccurred: new Date().toISOString(),
    });
  }
}

/**
 * Get all filter parse error counters.
 *
 * @returns Array of error entries with route, category, count, and last occurrence
 */
export function getFilterParseErrors(): FilterParseErrorEntry[] {
  return Array.from(counters.values());
}

/**
 * Reset all filter parse error counters.
 * Primarily for testing.
 */
export function resetFilterParseMetrics(): void {
  counters.clear();
}
