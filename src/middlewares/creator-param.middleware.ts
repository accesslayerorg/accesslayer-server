// src/middlewares/creator-param.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { sendValidationError } from '../utils/api-response.utils';

/**
 * Allowed characters for a creator param:
 * - Alphanumeric, hyphens, underscores (handles and UUIDs)
 * - 1–128 characters
 */
const CREATOR_PARAM_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Middleware factory that validates a named creator route param before
 * the handler runs.
 *
 * - Rejects missing, non-string, or malformed values with a 400 response.
 * - Calls next() for valid params so the handler receives a clean input.
 * - Reusable across any creator route that carries a creator identifier param.
 *
 * @param paramName - The route param key to validate (e.g. 'creatorId' or 'id')
 *
 * @example
 * router.get('/:creatorId/profile', validateCreatorParam('creatorId'), handler);
 * router.get('/:id/stats', validateCreatorParam('id'), handler);
 */
export function validateCreatorParam(paramName: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const value = req.params[paramName];

    if (!value || typeof value !== 'string') {
      sendValidationError(res, 'Invalid creator parameter', [
        {
          field: paramName,
          message: `Route parameter '${paramName}' is required`,
        },
      ]);
      return;
    }

    if (!CREATOR_PARAM_PATTERN.test(value)) {
      sendValidationError(res, 'Invalid creator parameter', [
        {
          field: paramName,
          message: `Route parameter '${paramName}' contains invalid characters or exceeds maximum length`,
        },
      ]);
      return;
    }

    next();
  };
}