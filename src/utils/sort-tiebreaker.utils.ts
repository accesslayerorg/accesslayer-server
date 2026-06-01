// src/utils/sort-tiebreaker.utils.ts
// Stable sort tie-breaker helpers for creator list sort paths.
// When the primary sort key produces equal values, applying a secondary
// deterministic key (the record's `id`) guarantees consistent ordering
// across repeated queries and prevents pages from overlapping or skipping rows.

/**
 * Compare two string values for ascending sort.
 * Returns negative, zero, or positive — compatible with Array.prototype.sort.
 */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Build a comparator that applies a primary sort key and falls back to a
 * stable tie-breaker (the record's `id` field) when the primary values tie.
 *
 * The tie-breaker is always ascending so the final order is deterministic
 * regardless of which direction the primary key is sorted.
 *
 * @param primaryKey  - Key to extract the primary sort value from each record
 * @param direction   - "asc" or "desc" for the primary key (default "asc")
 * @returns A comparator function suitable for Array.prototype.sort
 *
 * @example
 * const byFollowers = withTieBreaker<Creator>('followers', 'desc');
 * creators.sort(byFollowers);
 * // Items with equal followers are ordered by id ascending — stable across pages.
 */
export function withTieBreaker<T extends { id: string }>(
  primaryKey: keyof T,
  direction: 'asc' | 'desc' = 'asc',
): (a: T, b: T) => number {
  return (a: T, b: T): number => {
    const av = a[primaryKey];
    const bv = b[primaryKey];

    let primary: number;

    if (typeof av === 'number' && typeof bv === 'number') {
      primary = av - bv;
    } else {
      primary = compareStrings(String(av ?? ''), String(bv ?? ''));
    }

    if (direction === 'desc') primary = -primary;

    // Tie-break on `id` (always ascending) for deterministic order
    return primary !== 0 ? primary : compareStrings(a.id, b.id);
  };
}

/**
 * Sort an array of creator-like records by a primary key with a stable
 * id-based tie-breaker.  Returns a new sorted array (does not mutate input).
 *
 * @param items     - Records to sort
 * @param key       - Primary sort key
 * @param direction - Sort direction for the primary key
 */
export function stableSortCreators<T extends { id: string }>(
  items: T[],
  key: keyof T,
  direction: 'asc' | 'desc' = 'asc',
): T[] {
  return [...items].sort(withTieBreaker(key, direction));
}
