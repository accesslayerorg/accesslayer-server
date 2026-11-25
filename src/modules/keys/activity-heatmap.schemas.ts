import { z } from 'zod';

const FALLBACK_TIMEZONES = [
   'UTC',
   'Etc/UTC',
   'America/New_York',
   'America/Chicago',
   'America/Denver',
   'America/Los_Angeles',
   'America/Toronto',
   'America/Sao_Paulo',
   'Europe/London',
   'Europe/Paris',
   'Europe/Berlin',
   'Europe/Zurich',
   'Africa/Lagos',
   'Africa/Johannesburg',
   'Asia/Dubai',
   'Asia/Kolkata',
   'Asia/Singapore',
   'Asia/Tokyo',
   'Asia/Seoul',
   'Australia/Sydney',
   'Pacific/Auckland',
];

function buildSupportedTimezones(): Set<string> {
   try {
      const intlAny = Intl as unknown as {
         supportedValuesOf?: (key: string) => string[];
      };
      if (typeof intlAny.supportedValuesOf === 'function') {
         return new Set(['UTC', ...intlAny.supportedValuesOf('timeZone')]);
      }
   } catch {
      // Fallback below
   }
   return new Set(FALLBACK_TIMEZONES);
}

export const SUPPORTED_TIMEZONES = buildSupportedTimezones();

export const ALLOWED_HEATMAP_RANGES = [7, 30, 90] as const;
export type HeatmapRange = (typeof ALLOWED_HEATMAP_RANGES)[number];

export const activityHeatmapQuerySchema = z.object({
   range: z.coerce
      .number()
      .int()
      .refine((v): v is HeatmapRange => v === 7 || v === 30 || v === 90, {
         message: 'range must be 7, 30, or 90',
      })
      .optional()
      .default(30),
   tz: z
      .string()
      .trim()
      .min(1)
      .refine(val => SUPPORTED_TIMEZONES.has(val), {
         message: 'Unsupported or invalid IANA timezone',
      })
      .optional()
      .default('UTC'),
});

export type ActivityHeatmapQuery = z.infer<typeof activityHeatmapQuerySchema>;
