import { z } from 'zod';

export const ActivityFeedQuerySchema = z
   .object({
      cursor: z.string().optional(),
   })
   .strict();

export type ActivityFeedQueryType = z.infer<typeof ActivityFeedQuerySchema>;

export const PLATFORM_ACTIVITY_EVENT_TYPES = [
   'investment',
   'settlement',
   'new_listing',
   'fully_funded',
] as const;

export type PlatformActivityEventType =
   (typeof PLATFORM_ACTIVITY_EVENT_TYPES)[number];

export interface PlatformActivityFeedItem {
   type: PlatformActivityEventType;
   invoice_id: string;
   amount: string | null;
   wallet: string;
   timestamp: string;
}
