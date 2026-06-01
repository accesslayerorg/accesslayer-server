/**
 * Public endpoint cache settings.
 *
 * Keep this file limited to lightweight, reusable constants (no runtime logic).
 */
export const PUBLIC_ENDPOINT_CACHE_SECONDS = {
   short: 300,
   medium: 3600,
   long: 86400,
} as const;

export const PUBLIC_ENDPOINT_CACHE_PRESETS = {
   short: {
      maxAge: PUBLIC_ENDPOINT_CACHE_SECONDS.short,
      type: 'public' as const,
   },
   medium: {
      maxAge: PUBLIC_ENDPOINT_CACHE_SECONDS.medium,
      type: 'public' as const,
   },
   long: {
      maxAge: PUBLIC_ENDPOINT_CACHE_SECONDS.long,
      type: 'public' as const,
   },
} as const;

