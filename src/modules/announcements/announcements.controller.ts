// src/modules/announcements/announcements.controller.ts

import { Request, Response, NextFunction } from 'express';
import {
   sendSuccess,
   sendError,
   sendNotFound,
   sendForbidden,
   sendUnauthorized,
} from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import {
   createAnnouncement,
   updateAnnouncement,
   getAnnouncement,
   listAnnouncements,
   AnnouncementValidationError,
   AnnouncementNotFoundError,
   AnnouncementForbiddenError,
   AnnouncementInvalidStatusError,
} from './announcements.service';

export function extractWalletFromRequest(req: Request): string | undefined {
   const r = req as any;
   if (r.walletAddress) return r.walletAddress;
   if (r.user?.wallet) return r.user.wallet;
   const header = req.headers['x-wallet-address'];
   if (Array.isArray(header)) return header[0]?.trim() || undefined;
   if (typeof header === 'string') return header.trim() || undefined;
   return undefined;
}

/**
 * POST /v1/keys/:keyId/announcements
 * Schedules or immediately publishes an announcement for a creator key.
 */
export async function httpCreateAnnouncement(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const keyId = (req.params.keyId ?? req.params.key_id ?? req.params.id) as string;
      if (!keyId) {
         sendError(res, 400, ErrorCode.BAD_REQUEST, 'Missing required path parameter: keyId');
         return;
      }

      const wallet = extractWalletFromRequest(req);
      const result = await createAnnouncement(keyId, req.body, wallet);
      sendSuccess(res, result, 201);
   } catch (error) {
      if (error instanceof AnnouncementValidationError) {
         sendError(res, 400, ErrorCode.BAD_REQUEST, error.message);
         return;
      }
      next(error);
   }
}

/**
 * PATCH /v1/announcements/:id
 * Edits or cancels an announcement while its status is scheduled.
 */
export async function httpUpdateAnnouncement(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const id = String(req.params.id);
      if (!id) {
         sendError(res, 400, ErrorCode.BAD_REQUEST, 'Missing announcement id');
         return;
      }

      const wallet = extractWalletFromRequest(req);
      if (!wallet) {
         sendUnauthorized(
            res,
            'Wallet address is required to edit or cancel an announcement.'
         );
         return;
      }

      const result = await updateAnnouncement(id, req.body, wallet);
      sendSuccess(res, result, 200);
   } catch (error) {
      if (error instanceof AnnouncementNotFoundError) {
         sendNotFound(res, 'Announcement');
         return;
      }
      if (error instanceof AnnouncementForbiddenError) {
         sendForbidden(res, error.message);
         return;
      }
      if (
         error instanceof AnnouncementValidationError ||
         error instanceof AnnouncementInvalidStatusError
      ) {
         sendError(res, 400, ErrorCode.BAD_REQUEST, error.message);
         return;
      }
      next(error);
   }
}

/**
 * GET /v1/announcements/:id
 * Retrieves an announcement by id.
 */
export async function httpGetAnnouncement(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const id = String(req.params.id);
      const result = await getAnnouncement(id);
      sendSuccess(res, result, 200);
   } catch (error) {
      if (error instanceof AnnouncementNotFoundError) {
         sendNotFound(res, 'Announcement');
         return;
      }
      next(error);
   }
}

/**
 * GET /v1/keys/:keyId/announcements
 * Lists announcements for a given key.
 */
export async function httpListAnnouncements(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const keyId = (req.params.keyId ?? req.params.key_id ?? req.params.id) as string;
      const statusFilter = req.query.status as string | undefined;
      const result = await listAnnouncements(keyId, statusFilter);
      sendSuccess(res, result, 200);
   } catch (error) {
      next(error);
   }
}
