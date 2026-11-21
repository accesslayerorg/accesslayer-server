import { z } from 'zod';
export const KeyIdParamSchema = z.object({ keyId: z.string().min(1).max(128) }).strict();
export const FreezeBodySchema = z.object({ reason: z.string().min(3).max(500) }).strict();
export const UnfreezeBodySchema = z.object({ proposalId: z.string().min(1).max(128).optional(), reason: z.string().min(3).max(500).optional() }).strict();
export type FreezeBody = z.infer<typeof FreezeBodySchema>;
export type UnfreezeBody = z.infer<typeof UnfreezeBodySchema>;
