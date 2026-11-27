import { NextFunction, Request, Response } from 'express';
import {
   ErrorCode,
   sendError,
   sendNotFound,
   sendSuccess,
   sendValidationError,
} from '../../utils/api-response.utils';
import { AuthenticatedRequest } from '../../middlewares/jwt-auth.middleware';
import {
   BounceWebhookBodySchema,
   CreateBroadcastBodySchema,
   PreviewBroadcastBodySchema,
   UpdateBroadcastConsentBodySchema,
} from './broadcast.schemas';
import {
   BroadcastMonthlyLimitError,
   BroadcastRecipientLimitError,
   broadcastService,
   InvalidConsentTokenError,
   InvalidUnsubscribeTokenError,
} from './broadcast.service';

export async function httpPutBroadcastConsent(
   req: AuthenticatedRequest,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const parsed = UpdateBroadcastConsentBodySchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid broadcast consent payload',
            parsed.error.issues.map((issue) => ({
               field: issue.path.join('.') || 'body',
               message: issue.message,
            }))
         );
         return;
      }

      const wallet = req.user?.wallet ?? '';
      const userId = req.user?.userId ?? wallet;
      const keyId = String(req.params.keyId ?? '');

      const result = await broadcastService.setConsentPreference({
         userId,
         wallet,
         keyId,
         email: parsed.data.email,
         optIn: parsed.data.optIn,
      });

      sendSuccess(res, result);
   } catch (error) {
      next(error);
   }
}

export async function httpConfirmBroadcastConsent(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const token = String(req.query.token ?? '');
      if (!token) {
         sendValidationError(res, 'Missing confirmation token', [
            { field: 'token', message: 'token is required' },
         ]);
         return;
      }

      const confirmed = await broadcastService.confirmConsent(token);
      sendSuccess(res, { status: confirmed.status, keyId: confirmed.keyId });
   } catch (error) {
      if (error instanceof InvalidConsentTokenError) {
         sendError(res, 400, ErrorCode.VALIDATION_ERROR, error.message);
         return;
      }
      next(error);
   }
}

export async function httpUnsubscribeBroadcast(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const token = String(req.query.token ?? req.body?.token ?? '');
      if (!token) {
         sendValidationError(res, 'Missing unsubscribe token', [
            { field: 'token', message: 'token is required' },
         ]);
         return;
      }

      const result = await broadcastService.unsubscribeByToken(token);
      sendSuccess(res, { unsubscribed: true, ...result });
   } catch (error) {
      if (error instanceof InvalidUnsubscribeTokenError) {
         sendError(res, 400, ErrorCode.VALIDATION_ERROR, error.message);
         return;
      }
      next(error);
   }
}

export async function httpPreviewBroadcastAudience(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const parsed = PreviewBroadcastBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid preview payload',
            parsed.error.issues.map((issue) => ({
               field: issue.path.join('.') || 'body',
               message: issue.message,
            }))
         );
         return;
      }

      const keyId = String(req.params.id ?? '');
      const preview = await broadcastService.previewAudience(
         keyId,
         parsed.data.minBalance
      );
      sendSuccess(res, preview);
   } catch (error) {
      next(error);
   }
}

export async function httpCreateBroadcast(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const parsed = CreateBroadcastBodySchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid broadcast payload',
            parsed.error.issues.map((issue) => ({
               field: issue.path.join('.') || 'body',
               message: issue.message,
            }))
         );
         return;
      }

      const creatorId = String(req.params.id ?? '');
      const broadcast = await broadcastService.createBroadcast({
         creatorId,
         subject: parsed.data.subject,
         bodyHtml: parsed.data.bodyHtml,
         bodyText: parsed.data.bodyText,
         minBalance: parsed.data.minBalance,
         scheduledFor: parsed.data.scheduledFor
            ? new Date(parsed.data.scheduledFor)
            : undefined,
      });

      sendSuccess(res, broadcast, 201);
   } catch (error) {
      if (error instanceof BroadcastMonthlyLimitError) {
         sendError(res, 429, ErrorCode.RATE_LIMIT, error.message);
         return;
      }
      if (error instanceof BroadcastRecipientLimitError) {
         sendError(res, 400, ErrorCode.VALIDATION_ERROR, error.message);
         return;
      }
      next(error);
   }
}

export async function httpGetCreatorBroadcasts(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const handle = String(req.params.handle ?? '');
      const result = await broadcastService.getCreatorBroadcastsByHandle(handle);
      if (!result) {
         sendNotFound(res, `Creator '${handle}' not found`);
         return;
      }
      sendSuccess(res, result);
   } catch (error) {
      next(error);
   }
}

export async function httpHandleBounceWebhook(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const parsed = BounceWebhookBodySchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid bounce payload',
            parsed.error.issues.map((issue) => ({
               field: issue.path.join('.') || 'body',
               message: issue.message,
            }))
         );
         return;
      }

      await broadcastService.suppressEmail(parsed.data.email, parsed.data.type);
      sendSuccess(res, { suppressed: true, email: parsed.data.email });
   } catch (error) {
      next(error);
   }
}
