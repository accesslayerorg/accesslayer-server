/**
 * Normalizes a flat key-value param map into a canonical sorted order
 * before cache key generation.
 *
 * Two requests with the same parameters in different orders produce the
 * same canonical string, preventing duplicate cache entries.
 *
 * @param params - Object whose keys are param names and values are their
 *   serialized representations. `undefined` values are omitted.
 * @returns A colon-delimited string: `"key1:val1:key2:val2:..."` where
 *   keys are sorted lexicographically.
 *
 * @example
 * buildCanonicalParamString({ order: 'desc', limit: '20', sort: 'createdAt' })
 * // => "limit:20:order:desc:sort:createdAt"
 */
export function buildCanonicalParamString(
    params: Record<string, string | number | boolean | undefined>,
): string {
    return Object.entries(params)
        .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}:${value}`)
        .join(':');
}
