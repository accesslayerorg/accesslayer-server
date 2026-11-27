// src/modules/qa/qa.routes.ts
// Holder Q&A session, question, voting, and answer endpoints (#1311).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
   requireJwtAuth,
   requireKeyCreator,
   AuthenticatedRequest,
} from '../../middlewares/jwt-auth.middleware';
import {
   sendSuccess,
   sendError,
   sendValidationError,
   zodIssuesToDetails,
   ErrorCode,
   ErrorCodeType,
} from '../../utils/api-response.utils';
import { logger } from '../../utils/logger.utils';
import {
   scheduleQaSession,
   getQaSession,
   submitQaQuestion,
   voteQaQuestion,
   answerQaQuestion,
   QaServiceError,
   MAX_QUESTION_LENGTH,
} from './qa.service';

const scheduleSessionBodySchema = z.object({
   title: z.string().trim().min(1).max(200),
   description: z.string().trim().max(2000).optional(),
   startsAt: z.string().datetime(),
   durationMinutes: z.number().int().positive(),
   minBalance: z.number().nonnegative().default(1),
});

const scheduleSessionWithKeySchema = scheduleSessionBodySchema.extend({
   keyId: z.string().min(1),
});

const questionBodySchema = z.object({
   body: z.string().trim().min(1).max(MAX_QUESTION_LENGTH),
});

const answerBodySchema = z.object({
   answer: z.string().trim().min(1).max(4000),
});

function handleQaError(res: Response, error: unknown, context: string): void {
   if (error instanceof QaServiceError) {
      sendError(res, error.statusCode, error.code as ErrorCodeType, error.message);
      return;
   }
   logger.error({ error }, context);
   sendError(res, 500, ErrorCode.INTERNAL_ERROR, context);
}

export const keyQaRouter = Router();

keyQaRouter.post(
   '/:keyId/qa',
   requireKeyCreator('keyId'),
   async (req: AuthenticatedRequest, res: Response) => {
      const parsed = scheduleSessionBodySchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid Q&A session schedule payload',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      try {
         const session = await scheduleQaSession({
            keyId: String(req.params.keyId),
            creatorWallet: req.user!.wallet,
            ...parsed.data,
         });
         sendSuccess(res, { session }, 201);
      } catch (error) {
         handleQaError(res, error, 'Failed to schedule Q&A session');
      }
   }
);

export const qaRouter = Router();

qaRouter.post(
   '/',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response) => {
      const parsed = scheduleSessionWithKeySchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid Q&A session schedule payload',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      try {
         const session = await scheduleQaSession({
            ...parsed.data,
            creatorWallet: req.user!.wallet,
         });
         sendSuccess(res, { session }, 201);
      } catch (error) {
         handleQaError(res, error, 'Failed to schedule Q&A session');
      }
   }
);

qaRouter.get('/:id', async (req: Request, res: Response) => {
   const answeredRaw = req.query.answered;
   let answered: boolean | undefined;
   if (answeredRaw === 'true') answered = true;
   else if (answeredRaw === 'false') answered = false;
   else if (answeredRaw !== undefined) {
      sendValidationError(res, 'Invalid answered filter', [
         { field: 'answered', message: 'answered must be true or false' },
      ]);
      return;
   }

   try {
      const result = await getQaSession(String(req.params.id), answered);
      sendSuccess(res, result);
   } catch (error) {
      handleQaError(res, error, 'Failed to fetch Q&A session');
   }
});

qaRouter.post(
   '/:id/questions',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response) => {
      const parsed = questionBodySchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid Q&A question payload',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      try {
         const question = await submitQaQuestion({
            sessionId: String(req.params.id),
            authorWallet: req.user!.wallet,
            body: parsed.data.body,
         });
         sendSuccess(res, { question }, 201);
      } catch (error) {
         handleQaError(res, error, 'Failed to submit Q&A question');
      }
   }
);

qaRouter.post(
   '/questions/:id/vote',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response) => {
      try {
         const question = await voteQaQuestion({
            questionId: String(req.params.id),
            walletAddress: req.user!.wallet,
         });
         sendSuccess(res, { question });
      } catch (error) {
         handleQaError(res, error, 'Failed to vote on Q&A question');
      }
   }
);

qaRouter.post(
   '/questions/:id/answer',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response) => {
      const parsed = answerBodySchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid Q&A answer payload',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      try {
         const question = await answerQaQuestion({
            questionId: String(req.params.id),
            creatorWallet: req.user!.wallet,
            answer: parsed.data.answer,
         });
         sendSuccess(res, { question });
      } catch (error) {
         handleQaError(res, error, 'Failed to answer Q&A question');
      }
   }
);
