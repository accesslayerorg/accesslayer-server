// src/modules/reports/key-reports.schemas.ts
// Constants and request validation for key reports (#1226).

import { z } from 'zod';
import {
   DEFAULT_PAGE_SIZE,
   MAX_PAGE_SIZE,
} from '../../constants/pagination.constants';

export const KEY_REPORT_REASONS = [
   'scam',
   'impersonation',
   'harassment',
   'other',
] as const;
export type KeyReportReasonValue = (typeof KEY_REPORT_REASONS)[number];

export const KEY_REPORT_STATUSES = [
   'open',
   'reviewing',
   'dismissed',
   'actioned',
] as const;
export type KeyReportStatusValue = (typeof KEY_REPORT_STATUSES)[number];

/** Statuses a moderator may set via PATCH (a report can never be re-opened). */
export const KEY_REPORT_UPDATABLE_STATUSES = [
   'reviewing',
   'dismissed',
   'actioned',
] as const;

/**
 * Allowed moderator transitions. `dismissed` and `actioned` are terminal.
 * Self-transitions (e.g. reviewing -> reviewing) are rejected as no-ops.
 */
export const KEY_REPORT_TRANSITIONS: Record<
   KeyReportStatusValue,
   readonly KeyReportStatusValue[]
> = {
   open: ['reviewing', 'dismissed', 'actioned'],
   reviewing: ['dismissed', 'actioned'],
   dismissed: [],
   actioned: [],
};

export function isValidKeyReportTransition(
   from: KeyReportStatusValue,
   to: KeyReportStatusValue
): boolean {
   return KEY_REPORT_TRANSITIONS[from].includes(to);
}

export const KEY_REPORT_DETAILS_MAX_LENGTH = 500;

export const CreateKeyReportBodySchema = z
   .object({
      reason: z.enum(KEY_REPORT_REASONS, {
         errorMap: () => ({
            message: `reason must be one of: ${KEY_REPORT_REASONS.join(', ')}`,
         }),
      }),
      details: z
         .string()
         .trim()
         .max(
            KEY_REPORT_DETAILS_MAX_LENGTH,
            `details must be at most ${KEY_REPORT_DETAILS_MAX_LENGTH} characters`
         )
         .optional(),
   })
   .strict();
export type CreateKeyReportBody = z.infer<typeof CreateKeyReportBodySchema>;

export const ListKeyReportsQuerySchema = z.object({
   status: z
      .enum(KEY_REPORT_STATUSES, {
         errorMap: () => ({
            message: `status must be one of: ${KEY_REPORT_STATUSES.join(', ')}`,
         }),
      })
      .optional(),
   cursor: z.string().min(1).optional(),
   limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .default(DEFAULT_PAGE_SIZE),
});
export type ListKeyReportsQuery = z.infer<typeof ListKeyReportsQuerySchema>;

export const UpdateKeyReportBodySchema = z
   .object({
      status: z.enum(KEY_REPORT_UPDATABLE_STATUSES, {
         errorMap: () => ({
            message: `status must be one of: ${KEY_REPORT_UPDATABLE_STATUSES.join(', ')}`,
         }),
      }),
   })
   .strict();
export type UpdateKeyReportBody = z.infer<typeof UpdateKeyReportBodySchema>;
