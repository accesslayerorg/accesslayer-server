import type { Request, Response } from 'express';
import {
  sendSuccess,
  sendError,
  sendValidationError,
  sendNotFound,
} from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import { CreateAlertSchema } from './alert.schemas';
import * as alertService from './alert.service';

export async function registerAlertHandler(
  req: Request,
  res: Response
): Promise<void> {
  const parseResult = CreateAlertSchema.safeParse(req.body);
  if (!parseResult.success) {
    sendValidationError(
      res,
      'Invalid alert registration data',
      parseResult.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }))
    );
    return;
  }

  try {
    const result = await alertService.createAlert({
      creatorId: parseResult.data.creator_id,
      walletAddress: parseResult.data.wallet_address,
      targetPrice: parseResult.data.target_price,
      direction: parseResult.data.direction,
      callbackUrl: parseResult.data.callback_url,
    });
    sendSuccess(res, result, 201, 'Alert registered successfully');
  } catch {
    sendError(res, 500, ErrorCode.INTERNAL_ERROR, 'Failed to register alert');
  }
}

export async function deleteAlertHandler(
  req: Request,
  res: Response
): Promise<void> {
  const rawAlertId = req.params.id;
  const alertId = Array.isArray(rawAlertId) ? rawAlertId[0] : rawAlertId;

  if (!alertId) {
    sendError(res, 400, ErrorCode.BAD_REQUEST, 'Missing alert ID in path');
    return;
  }

  try {
    const result = await alertService.deleteAlert(alertId);
    if (!result) {
      sendNotFound(res, 'Alert');
      return;
    }
    sendSuccess(res, result, 200, 'Alert cancelled successfully');
  } catch {
    sendError(res, 500, ErrorCode.INTERNAL_ERROR, 'Failed to cancel alert');
  }
}
