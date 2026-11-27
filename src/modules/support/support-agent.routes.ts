// src/modules/support/support-agent.routes.ts
// Support agent endpoints (#1327). Mounted at /admin/support and guarded by
// the admin JWT, the same as the rest of the admin surface.

import { Request, Response, Router } from 'express';
import { adminGuard, AdminRequest } from '../../middlewares/admin-guard.middleware';
import {
   sendConflict,
   sendNotFound,
   sendPaginatedSuccess,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   assignTicket,
   getAttachmentForAgent,
   getTicketForAgent,
   InvalidStatusTransitionError,
   listTicketsForAgents,
   replyAsAgent,
   setTicketStatus,
   TicketClosedError,
   TicketNotFoundError,
   AttachmentNotFoundError,
} from './support-ticket.service';
import { sendAttachmentFile } from './support.routes';
import {
   agentListTicketsQuerySchema,
   agentReplyBodySchema,
   assignBodySchema,
   statusBodySchema,
   ticketIdParamSchema,
} from './support.schemas';

export const supportAgentRouter = Router();

function agentIdOf(req: Request): string {
   return (req as AdminRequest).adminId as string;
}

/** Shared mapping of ticket-state errors to HTTP responses. */
function handleTicketError(res: Response, error: unknown): boolean {
   if (error instanceof TicketNotFoundError) {
      sendNotFound(res, 'Support ticket');
      return true;
   }
   if (error instanceof AttachmentNotFoundError) {
      sendNotFound(res, 'Attachment');
      return true;
   }
   if (error instanceof TicketClosedError || error instanceof InvalidStatusTransitionError) {
      sendConflict(res, error.message);
      return true;
   }
   return false;
}

function parseTicketId(req: Request, res: Response): string | null {
   const ticketId = ticketIdParamSchema.safeParse(req.params.ticketId);
   if (!ticketId.success) {
      sendValidationError(res, 'Invalid ticket id');
      return null;
   }
   return ticketId.data;
}

/** GET /admin/support/tickets — every ticket, filterable by status and assignee. */
supportAgentRouter.get('/tickets', adminGuard, async (req, res, next) => {
   const query = agentListTicketsQuerySchema.safeParse(req.query);
   if (!query.success) {
      sendValidationError(res, 'Invalid query', zodIssuesToDetails(query.error.issues));
      return;
   }
   try {
      const { data, meta } = await listTicketsForAgents(query.data);
      sendPaginatedSuccess(res, data, meta);
   } catch (error) {
      next(error);
   }
});

/** GET /admin/support/tickets/:ticketId — full thread, attachments and history. */
supportAgentRouter.get('/tickets/:ticketId', adminGuard, async (req, res, next) => {
   const ticketId = parseTicketId(req, res);
   if (!ticketId) return;
   try {
      sendSuccess(res, await getTicketForAgent(ticketId));
   } catch (error) {
      if (!handleTicketError(res, error)) next(error);
   }
});

/** POST /admin/support/tickets/:ticketId/assign — assign to `assigneeId`, or to the caller. */
supportAgentRouter.post('/tickets/:ticketId/assign', adminGuard, async (req, res, next) => {
   const ticketId = parseTicketId(req, res);
   if (!ticketId) return;
   const body = assignBodySchema.safeParse(req.body ?? {});
   if (!body.success) {
      sendValidationError(res, 'Invalid body', zodIssuesToDetails(body.error.issues));
      return;
   }
   try {
      sendSuccess(res, await assignTicket(ticketId, body.data.assigneeId ?? agentIdOf(req)));
   } catch (error) {
      if (!handleTicketError(res, error)) next(error);
   }
});

/**
 * POST /admin/support/tickets/:ticketId/replies — reply to the user. An open
 * ticket moves to `waiting` unless `status` is given. The user is emailed once.
 */
supportAgentRouter.post('/tickets/:ticketId/replies', adminGuard, async (req, res, next) => {
   const ticketId = parseTicketId(req, res);
   if (!ticketId) return;
   const body = agentReplyBodySchema.safeParse(req.body);
   if (!body.success) {
      sendValidationError(res, 'Invalid reply', zodIssuesToDetails(body.error.issues));
      return;
   }
   try {
      sendSuccess(
         res,
         await replyAsAgent(ticketId, agentIdOf(req), body.data),
         201
      );
   } catch (error) {
      if (!handleTicketError(res, error)) next(error);
   }
});

/** POST /admin/support/tickets/:ticketId/status — set a status; the change is timestamped. */
supportAgentRouter.post('/tickets/:ticketId/status', adminGuard, async (req, res, next) => {
   const ticketId = parseTicketId(req, res);
   if (!ticketId) return;
   const body = statusBodySchema.safeParse(req.body);
   if (!body.success) {
      sendValidationError(res, 'Invalid status', zodIssuesToDetails(body.error.issues));
      return;
   }
   try {
      sendSuccess(res, await setTicketStatus(ticketId, agentIdOf(req), body.data.status));
   } catch (error) {
      if (!handleTicketError(res, error)) next(error);
   }
});

/** GET /admin/support/tickets/:ticketId/attachments/:attachmentId — download a file. */
supportAgentRouter.get(
   '/tickets/:ticketId/attachments/:attachmentId',
   adminGuard,
   async (req, res, next) => {
      try {
         sendAttachmentFile(
            res,
            await getAttachmentForAgent(String(req.params.ticketId), String(req.params.attachmentId))
         );
      } catch (error) {
         if (!handleTicketError(res, error)) next(error);
      }
   }
);

export default supportAgentRouter;
