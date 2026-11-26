// src/modules/support/support.schemas.ts
// Request validation for support ticket routes (#1327).

import { z } from 'zod';
import {
   ATTACHMENT_NAME_MAX_LENGTH,
   MAX_ATTACHMENTS_PER_TICKET,
   MAX_ATTACHMENT_BYTES,
   SUPPORT_CATEGORIES,
   TICKET_STATUSES,
} from './support.constants';

export const attachmentDeclarationSchema = z.object({
   fileName: z.string().trim().min(1).max(ATTACHMENT_NAME_MAX_LENGTH),
   contentType: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .transform(value => value.toLowerCase()),
   sizeBytes: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
});

export const createTicketSchema = z.object({
   category: z.enum(SUPPORT_CATEGORIES),
   subject: z.string().trim().min(5).max(140),
   description: z.string().trim().min(10).max(5000),
   attachments: z.array(attachmentDeclarationSchema).max(MAX_ATTACHMENTS_PER_TICKET).default([]),
});

export const ticketIdParamSchema = z.string().trim().min(1).max(64);

export const listTicketsQuerySchema = z.object({
   page: z.coerce.number().int().min(1).max(10_000).default(1),
   limit: z.coerce.number().int().min(1).max(50).default(20),
   status: z.enum(TICKET_STATUSES).optional(),
});

export const agentListTicketsQuerySchema = listTicketsQuerySchema.extend({
   assigneeId: z.string().trim().min(1).max(64).optional(),
});

export const messageBodySchema = z.object({
   body: z.string().trim().min(1).max(5000),
});

export const agentReplyBodySchema = messageBodySchema.extend({
   status: z.enum(TICKET_STATUSES).optional(),
});

export const statusBodySchema = z.object({
   status: z.enum(TICKET_STATUSES),
});

export const assignBodySchema = z.object({
   assigneeId: z.string().trim().min(1).max(64).optional(),
});
