// src/modules/status/status.schemas.ts
// Zod schemas for platform status health check and incident endpoints (#1015).

import { z } from 'zod';

const isoDateString = z
   .string()
   .refine(val => !Number.isNaN(Date.parse(val)), {
      message: 'Invalid ISO date string',
   });

export const createIncidentSchema = z.object({
   title: z.string().trim().min(1, 'Title is required'),
   services: z
      .union([
         z.string().trim().min(1),
         z.array(z.string().trim().min(1)).min(1, 'At least one service is required'),
      ])
      .transform(val => (Array.isArray(val) ? val : [val])),
   status: z
      .enum(['investigating', 'identified', 'monitoring', 'resolved', 'open'])
      .optional()
      .default('investigating'),
   impact: z
      .enum(['none', 'minor', 'major', 'critical'])
      .optional()
      .default('minor'),
   start: isoDateString.optional(),
   startedAt: isoDateString.optional(),
   resolution: z.string().trim().optional().nullable(),
   resolvedAt: isoDateString.optional().nullable(),
});

export const incidentsQuerySchema = z.object({
   page: z.coerce.number().int().min(1).default(1),
   limit: z.coerce.number().int().min(1).max(100).default(20),
   status: z.string().trim().optional(),
   service: z.string().trim().optional(),
});

export const historyQuerySchema = z.object({
   windowDays: z.coerce.number().int().min(1).max(90).default(30),
});
