/**
 * Normalize free-text creator list search terms before filtering.
 *
 * Scope is intentionally narrow and reusable:
 * - Accepts `string | null | undefined`
 * - Trims leading/trailing whitespace
 * - Collapses internal whitespace to single spaces
 * - Returns `undefined` for empty/whitespace-only values
 */
export function normalizeCreatorListSearchTerm(
   term: string | null | undefined
): string | undefined {
   if (typeof term !== 'string') {
      return undefined;
   }

   const normalized = term.trim().replace(/\s+/g, ' ');
   return normalized === '' ? undefined : normalized;
}

