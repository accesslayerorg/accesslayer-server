// src/modules/creator/creator-not-found.utils.ts
import { Response } from 'express';
import { sendError } from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';

/**
 * Sends a consistent 404 JSON response for creator route endpoints.
 *
 * Centralises the not-found payload so every creator handler returns
 * the same status code, error code, and message without duplicating
 * the `sendError` call inline.
 *
 * @param res - Express Response object
 *
 * @example
 * const creator = await findCreatorById(id);
 * if (!creator) {
 *   sendCreatorNotFound(res);
 *   return;
 * }
 */
export function sendCreatorNotFound(res: Response): void {
  sendError(res, 404, ErrorCode.NOT_FOUND, 'Creator not found');
}
