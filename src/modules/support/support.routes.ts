// src/modules/support/support.routes.ts
// User-facing support ticket endpoints (#1327). Mounted at /support.
//
// The attachment upload router is mounted before the JSON-parsed group, so
// the raw file bytes reach the handler untouched.

import express, { Response, Router } from 'express';
import { ErrorCode } from '../../constants/error.constants';
import { linkedUserIdOf, requireLinkedUser } from '../../middlewares/linked-user.middleware';
import {
   sendConflict,
   sendError,
   sendNotFound,
   sendPaginatedSuccess,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { AttachmentPolicyError } from './attachment-policy.utils';
import {
   addUserMessage,
   AttachmentNotFoundError,
   AttachmentUploadError,
   createSupportTicket,
   getUserAttachment,
   getUserTicket,
   listUserTickets,
   storeAttachmentUpload,
   TicketClosedError,
   TicketNotFoundError,
} from './support-ticket.service';
import {
   createTicketSchema,
   listTicketsQuerySchema,
   messageBodySchema,
   ticketIdParamSchema,
} from './support.schemas';
import { MAX_ATTACHMENT_BYTES } from './support.constants';

/** Maps an attachment policy error to a 400 or 422 response. */
export function sendAttachmentPolicyError(res: Response, error: AttachmentPolicyError): void {
   const code = error.statusCode === 422 ? ErrorCode.UNPROCESSABLE_ENTITY : ErrorCode.VALIDATION_ERROR;
   const details = error.field ? [{ field: error.field, message: error.message }] : undefined;
   sendError(res, error.statusCode, code, error.message, details);
}

/** Maps an upload-link error to its HTTP response. */
export function sendUploadError(res: Response, error: AttachmentUploadError): void {
   const code =
      error.statusCode === 403
         ? ErrorCode.FORBIDDEN
         : error.statusCode === 404
           ? ErrorCode.NOT_FOUND
           : ErrorCode.CONFLICT;
   sendError(res, error.statusCode, code, error.message);
}

/** Streams an attachment's bytes with headers that keep them from running in a browser. */
export function sendAttachmentFile(
   res: Response,
   file: { fileName: string; contentType: string; content: Buffer }
): void {
   const safeName = file.fileName.replace(/[^A-Za-z0-9._-]/g, '_');
   res.setHeader('Content-Type', file.contentType);
   res.setHeader('Content-Length', String(file.content.length));
   res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
   res.setHeader('X-Content-Type-Options', 'nosniff');
   res.setHeader('Cache-Control', 'private, no-store');
   res.status(200).end(file.content);
}

// ── Attachment upload (signed link, raw bytes) ──────────────

export const supportAttachmentUploadRouter = Router();

/**
 * PUT /support/attachments/:attachmentId/upload?expires=&sig=
 * Accepts the raw bytes for one attachment. The signed link authorises the
 * upload; the bytes are checked against the declared size and type.
 */
supportAttachmentUploadRouter.put(
   '/attachments/:attachmentId/upload',
   express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES }),
   async (req, res, next) => {
      const expires = Number(req.query.expires);
      const signature = typeof req.query.sig === 'string' ? req.query.sig : '';
      if (!Number.isFinite(expires) || signature.length === 0) {
         sendValidationError(res, 'Upload link is missing its expiry or signature');
         return;
      }
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      try {
         sendSuccess(
            res,
            await storeAttachmentUpload(req.params.attachmentId, expires, signature, bytes)
         );
      } catch (error) {
         if (error instanceof AttachmentUploadError) {
            sendUploadError(res, error);
            return;
         }
         if (error instanceof AttachmentPolicyError) {
            sendAttachmentPolicyError(res, error);
            return;
         }
         next(error);
      }
   }
);

// ── Tickets (signed-in user) ────────────────────────────────

export const supportRouter = Router();

/** POST /support/tickets — create a ticket and reserve upload slots for attachments. */
supportRouter.post('/tickets', requireLinkedUser, async (req, res, next) => {
   const body = createTicketSchema.safeParse(req.body);
   if (!body.success) {
      sendValidationError(res, 'Invalid ticket', zodIssuesToDetails(body.error.issues));
      return;
   }
   try {
      sendSuccess(res, await createSupportTicket(linkedUserIdOf(req), body.data), 201);
   } catch (error) {
      if (error instanceof AttachmentPolicyError) {
         sendAttachmentPolicyError(res, error);
         return;
      }
      next(error);
   }
});

/** GET /support/tickets — the caller's tickets, most recently active first. */
supportRouter.get('/tickets', requireLinkedUser, async (req, res, next) => {
   const query = listTicketsQuerySchema.safeParse(req.query);
   if (!query.success) {
      sendValidationError(res, 'Invalid query', zodIssuesToDetails(query.error.issues));
      return;
   }
   try {
      const { data, meta } = await listUserTickets(linkedUserIdOf(req), query.data);
      sendPaginatedSuccess(res, data, meta);
   } catch (error) {
      next(error);
   }
});

/** GET /support/tickets/:ticketId — one ticket with its thread and status history. */
supportRouter.get('/tickets/:ticketId', requireLinkedUser, async (req, res, next) => {
   const ticketId = ticketIdParamSchema.safeParse(req.params.ticketId);
   if (!ticketId.success) {
      sendValidationError(res, 'Invalid ticket id');
      return;
   }
   try {
      sendSuccess(res, await getUserTicket(linkedUserIdOf(req), ticketId.data));
   } catch (error) {
      if (error instanceof TicketNotFoundError) {
         sendNotFound(res, 'Support ticket');
         return;
      }
      next(error);
   }
});

/** POST /support/tickets/:ticketId/messages — reply on the caller's ticket. */
supportRouter.post('/tickets/:ticketId/messages', requireLinkedUser, async (req, res, next) => {
   const ticketId = ticketIdParamSchema.safeParse(req.params.ticketId);
   const body = messageBodySchema.safeParse(req.body);
   if (!ticketId.success || !body.success) {
      sendValidationError(
         res,
         'Invalid message',
         body.success ? undefined : zodIssuesToDetails(body.error.issues)
      );
      return;
   }
   try {
      sendSuccess(
         res,
         await addUserMessage(linkedUserIdOf(req), ticketId.data, body.data.body),
         201
      );
   } catch (error) {
      if (error instanceof TicketNotFoundError) {
         sendNotFound(res, 'Support ticket');
         return;
      }
      if (error instanceof TicketClosedError) {
         sendConflict(res, error.message);
         return;
      }
      next(error);
   }
});

/** GET /support/tickets/:ticketId/attachments/:attachmentId — download an uploaded file. */
supportRouter.get(
   '/tickets/:ticketId/attachments/:attachmentId',
   requireLinkedUser,
   async (req, res, next) => {
      try {
         const file = await getUserAttachment(
            linkedUserIdOf(req),
            String(req.params.ticketId),
            String(req.params.attachmentId)
         );
         sendAttachmentFile(res, file);
      } catch (error) {
         if (error instanceof AttachmentNotFoundError) {
            sendNotFound(res, 'Attachment');
            return;
         }
         next(error);
      }
   }
);

export default supportRouter;
