/**
 * Query parameters commonly used for click tracking that should be stripped
 * before storing social profile URLs.
 */
const TRACKING_QUERY_PARAMS = new Set([
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'msclkid',
  'ref',
  'ref_src',
  'ref_url',
  'utm_campaign',
  'utm_content',
  'utm_medium',
  'utm_source',
  'utm_term',
]);

/**
 * Normalizes a social profile URL for consistent storage and comparison.
 *
 * - Removes trailing slashes from the path (preserves root `/`)
 * - Lowercases the host component
 * - Strips common tracking query parameters
 */
export function normalizeSocialLinkUrl(raw: string): string {
  const trimmed = raw.trim();
  const parsed = new URL(trimmed);

  parsed.hostname = parsed.hostname.toLowerCase();

  for (const param of [...parsed.searchParams.keys()]) {
    if (TRACKING_QUERY_PARAMS.has(param.toLowerCase())) {
      parsed.searchParams.delete(param);
    }
  }

  let normalized = parsed.toString();

  if (parsed.pathname !== '/' && normalized.endsWith('/')) {
    normalized = normalized.replace(/\/+$/, '');
  }

  return normalized;
}
