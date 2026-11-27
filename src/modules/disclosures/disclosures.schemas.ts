import { z } from 'zod';

export const acceptDisclosureSchema = z.object({
   versionId: z.string().trim().min(1, 'versionId is required').max(128),
});

export const publishDisclosureSchema = z.object({
   version: z.string().trim().min(1, 'version is required').max(64),
   textHash: z.string().trim().min(1, 'textHash is required').max(128),
   contentUrl: z.string().trim().url('contentUrl must be a valid URL').max(512),
});

export type AcceptDisclosureInput = z.infer<typeof acceptDisclosureSchema>;
export type PublishDisclosureInput = z.infer<typeof publishDisclosureSchema>;
