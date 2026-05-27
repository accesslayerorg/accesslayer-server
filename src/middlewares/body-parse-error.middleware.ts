import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.utils';
import { getClientIp } from '../utils/client-ip.utils';
import { ErrorCode } from '../constants/error.constants';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Intercepts body-parsing errors on mutation endpoints (POST, PUT, PATCH,
 * DELETE) and emits a structured error-level log entry before returning the
 * client a 400 response.
 *
 * What IS logged:
 *   - endpoint path
 *   - HTTP method
 *   - request ID (for correlation)
 *   - client IP (extracted via the trusted-proxy-aware helper)
 *   - error type / code
 *
 * What is NOT logged:
 *   - raw request body (never read or forwarded)
 *   - request headers beyond what Express already exposes on req
 */
export const bodyParseErrorMiddleware = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const isSyntaxError =
    err instanceof SyntaxError && 'body' in err;
  const isEntityTooLarge =
    err.type === 'entity.too.large' ||
    err.status === 413 ||
    err.statusCode === 413;

  const isParseFailure = isSyntaxError || isEntityTooLarge;

  if (!isParseFailure || !MUTATION_METHODS.has(req.method)) {
    return next(err);
  }

  const clientIp = getClientIp(req);

  logger.error({
    type: 'body_parse_failure',
    method: req.method,
    path: req.originalUrl || req.url,
    requestId: req.requestId,
    clientIp,
    errorType: isEntityTooLarge ? 'entity.too.large' : 'invalid_json',
  });

  if (isEntityTooLarge) {
    res.status(413).json({
      success: false,
      code: ErrorCode.BAD_REQUEST,
      message: 'Request payload too large',
    });
    return;
  }

  res.status(400).json({
    success: false,
    code: ErrorCode.BAD_REQUEST,
    message: 'Invalid JSON in request body',
  });
};
