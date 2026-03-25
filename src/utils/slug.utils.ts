// src/utils/slug.utils.ts
// Reusable helper for generating stable creator slugs from names or handles.

/**
 * Generates a URL-safe slug from a name or handle.
 *
 * - Converts to lowercase
 * - Replaces spaces and special characters with hyphens
 * - Collapses consecutive hyphens
 * - Trims leading/trailing hyphens
 * - Strips non-alphanumeric characters (except hyphens)
 *
 * Repeated calls with the same input always return the same slug.
 *
 * @example
 * generateSlug("John Doe")        // "john-doe"
 * generateSlug("  Lil Nas X  ")   // "lil-nas-x"
 * generateSlug("café & créme")    // "caf-crme"
 * generateSlug("Hello---World")   // "hello-world"
 */
export function generateSlug(input: string): string {
   return input
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-') // spaces and underscores to hyphens
      .replace(/[^a-z0-9-]/g, '') // strip non-alphanumeric (except hyphens)
      .replace(/-{2,}/g, '-') // collapse multiple hyphens
      .replace(/^-+|-+$/g, ''); // trim leading/trailing hyphens
}

/**
 * Generates a slug with an optional numeric suffix for uniqueness.
 *
 * Useful when the caller has already checked for collisions and needs
 * to append a disambiguator.
 *
 * @example
 * generateSlugWithSuffix("John Doe", 2) // "john-doe-2"
 */
export function generateSlugWithSuffix(
   input: string,
   suffix: number
): string {
   const base = generateSlug(input);
   return suffix > 0 ? `${base}-${suffix}` : base;
}
