import type { Response } from 'express';
import {
  sendSuccess,
  sendError,
  sendValidationError,
  sendNotFound,
} from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import { CreateWebhookSchema } from './webhook.schemas';
import * as webhookService from './webhook.service';
import type { WalletSignedRequest } from './webhook-signature.middleware';

export async function registerWebhookHandler(
  req: WalletSignedRequest,
  res: Response
) {
  const parseResult = CreateWebhookSchema.safeParse(req.body);
  if (!parseResult.success) {
    sendValidationError(
      res,
      'Invalid webhook registration data',
      parseResult.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }))
    );
    return;
  }

  try {
    const result = await webhookService.createWebhook(
      req.creatorId!,
      {
        callbackUrl: parseResult.data.callback_url,
        events: parseResult.data.events,
      }
    );
    sendSuccess(res, result, 201, 'Webhook registered successfully');
  } catch (error) {
    if (error instanceof Error && 'statusCode' in error) {
      sendError(
        res,
        (error as any).statusCode,
        (error as any).code,
        error.message
      );
      return;
    }
    sendError(res, 500, ErrorCode.INTERNAL_ERROR, 'Failed to register webhook');
  }
}

export async function listWebhooksHandler(
  req: WalletSignedRequest,
  res: Response
) {
  try {
    const webhooks = await webhookService.listWebhooks(req.creatorId!);
    sendSuccess(res, webhooks);
  } catch {
    sendError(res, 500, ErrorCode.INTERNAL_ERROR, 'Failed to list webhooks');
  }
}

export async function deleteWebhookHandler(
  req: WalletSignedRequest,
  res: Response
) {
  const rawWebhookId = req.params.webhookId;
  const webhookId = Array.isArray(rawWebhookId) ? rawWebhookId[0] : rawWebhookId;

  if (!webhookId) {
    sendError(res, 400, ErrorCode.BAD_REQUEST, 'Missing webhook ID in path');
    return;
  }

  try {
    const result = await webhookService.deleteWebhook(
      webhookId,
      req.creatorId!
    );
    if (!result) {
      sendNotFound(res, 'Webhook');
      return;
    }
    res.status(204).end();
  } catch {
    sendError(res, 500, ErrorCode.INTERNAL_ERROR, 'Failed to delete webhook');
  }
}
