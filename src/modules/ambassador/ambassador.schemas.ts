import { z } from 'zod';

export const recordClickSchema = z.object({
   referralCode: z.string().trim().min(1, 'referralCode is required').max(64),
   cookieId: z.string().trim().min(1, 'cookieId is required').max(128),
   utmSource: z.string().trim().max(128).optional(),
   utmMedium: z.string().trim().max(128).optional(),
   utmCampaign: z.string().trim().max(128).optional(),
   utmTerm: z.string().trim().max(128).optional(),
   utmContent: z.string().trim().max(128).optional(),
});

export const ambassadorStatsQuerySchema = z.object({
   range: z.enum(['7d', '30d', '90d', 'all']).optional().default('30d'),
});

export const ambassadorPayoutsQuerySchema = z.object({
   cursor: z.string().trim().min(1).optional(),
   limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export type RecordClickInput = z.infer<typeof recordClickSchema>;
export type AmbassadorStatsRange = z.infer<typeof ambassadorStatsQuerySchema>['range'];
export type AmbassadorPayoutsQuery = z.infer<typeof ambassadorPayoutsQuerySchema>;
