// src/modules/comments/comments.routes.ts
//
// REST endpoints for key comments (#1221):
//
//   GET   /keys/:key_id/comments?cursor=&limit=  — paginated top-level comments with nested replies
//   POST  /keys/:key_id/comments                 — wallet-authenticated, 500-char limit, optional parentId
//   PATCH /comments/:id                          — creator-only hide toggle

import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { AsyncController } from '../../types/auth.types';
import {
   sendSuccess,
   sendValidationError,
   sendNotFound,
   sendError,
} from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import { requireStellarSignature } from '../../middlewares/stellar-signature.middleware';
import type { StellarSignedRequest } from '../../middlewares/stellar-signature.middleware';
import {
   listComments,
   createComment,
   hideComment,
   getComment,
   getKeyCreatorWallet,
   validateBody as validateCommentBody,
} from './comments.service';

const commentsRouter = Router();
const moderationRouter = Router();

const normalizeKeyId = (req: Request, _res: Response, next: NextFunction) => {
   if (!req.params.keyId && req.params.key_id) {
      req.params.keyId = req.params.key_id;
   }
   next();
};

const ListCommentsQuerySchema = z.object({
   limit: z.coerce.number().int().min(1).max(100).default(20),
   cursor: z.string().min(1).optional(),
});

const CreateCommentBodySchema = z.object({
   body: z.string(),
   parentId: z.string().min(1).optional().nullable(),
});

function errorForService(err: unknown): { status: number; code: string; message: string } | null {
   const msg = err instanceof Error ? err.message : String(err);
   if (msg === 'INVALID_PARENT') {
      return { status: 400, code: ErrorCode.VALIDATION_ERROR, message: 'Invalid parent comment' };
   }
   if (msg === 'REPLY_TO_REPLY') {
      return { status: 400, code: ErrorCode.VALIDATION_ERROR, message: 'Replies to replies are not allowed' };
   }
   return null;
}

// GET /keys/:key_id/comments
const httpListComments: AsyncController = async (req, res, next) => {
   try {
      const keyId = (req.params.key_id ?? req.params.keyId) as string;
      if (!keyId) {
         return sendValidationError(res, 'Missing required parameters', [
            { field: 'keyId', message: 'Key ID is required' },
         ]);
      }

      const parsedQuery = ListCommentsQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
         return sendValidationError(
            res,
            'Invalid comments query',
            parsedQuery.error.issues.map(i => ({ field: i.path.join('.'), message: i.message }))
         );
      }

      return sendSuccess(
         res,
         await listComments(keyId, parsedQuery.data.limit, parsedQuery.data.cursor)
      );
   } catch (error) {
      next(error);
   }
};

// POST /keys/:key_id/comments
const httpCreateComment: AsyncController = async (req, res, next) => {
   const stellarReq = req as StellarSignedRequest;
   const keyId = (req.params.key_id ?? req.params.keyId) as string;
   if (!keyId) {
      return sendValidationError(res, 'Missing required parameters', [
         { field: 'keyId', message: 'Key ID is required' },
      ]);
   }

   const parsed = CreateCommentBodySchema.safeParse(req.body ?? {});
   if (!parsed.success) {
      return sendValidationError(
         res,
         'Invalid comment body',
         parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message }))
      );
   }

   const validationError = validateCommentBody(parsed.data.body);
   if (validationError) {
      return sendError(res, 400, ErrorCode.VALIDATION_ERROR, validationError);
   }

   const author = stellarReq.walletAddress;
   if (!author) {
      return sendError(res, 401, ErrorCode.UNAUTHORIZED, 'Wallet authentication required');
   }

   try {
      const comment = await createComment(keyId, author, parsed.data.body, parsed.data.parentId ?? null);
      return sendSuccess(res, comment, 201);
   } catch (error) {
      const mapped = errorForService(error);
      if (mapped) {
         return sendError(res, mapped.status, mapped.code as any, mapped.message);
      }
      next(error);
   }
};

commentsRouter.get(
   ['/:key_id/comments', '/:keyId/comments'],
   normalizeKeyId,
   httpListComments
);

commentsRouter.post(
   ['/:key_id/comments', '/:keyId/comments'],
   normalizeKeyId,
   requireStellarSignature(),
   httpCreateComment
);

commentsRouter.all(['/:key_id/comments', '/:keyId/comments'], (_req, res) => {
   res.set('Allow', 'GET, POST').sendStatus(405);
});

// PATCH /comments/:id
const httpPatchComment: AsyncController = async (req, res, next) => {
   const stellarReq = req as StellarSignedRequest;
   const id = String(req.params.id);
   const existing = await getComment(id);
   if (!existing) {
      return sendNotFound(res, 'Comment');
   }

   const creatorWallet = await getKeyCreatorWallet(existing.keyId);
   const caller = stellarReq.walletAddress;
   if (!caller || !creatorWallet || caller !== creatorWallet) {
      return sendError(res, 403, ErrorCode.FORBIDDEN, 'Only the key creator can moderate comments');
   }

   const hidden = req.body?.hidden;
   if (typeof hidden !== 'boolean') {
      return sendError(res, 400, ErrorCode.VALIDATION_ERROR, 'hidden must be a boolean');
   }

   try {
      const updated = await hideComment(id, hidden);
      if (!updated) return sendNotFound(res, 'Comment');
      return sendSuccess(res, updated);
   } catch (error) {
      next(error);
   }
};

moderationRouter.patch('/:id', requireStellarSignature(), httpPatchComment);

export default commentsRouter;
export { moderationRouter as commentsModerationRouter };
