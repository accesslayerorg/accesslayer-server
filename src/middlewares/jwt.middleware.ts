import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { envConfig } from '../config';
import { sendUnauthorized } from '../utils/api-response.utils';
import { logger } from '../utils/logger.utils';
import { getClientIp } from '../utils/client-ip.utils';
import { logExpiredTokenRejection } from '../utils/expired-token-log.utils';

export interface JwtPayload {
  walletAddress: string;
  sub: string;
}

declare global {
  namespace Express {
    interface Request {
      jwtPayload?: JwtPayload;
    }
  }
}

export function jwtAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn(
      {
        type: 'auth_rejection',
        reason: 'missing_token',
        endpoint: req.path,
        ip_address: getClientIp(req),
      },
      'Authentication rejected: missing token'
    );
    sendUnauthorized(res, 'Missing or invalid authorization header');
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, envConfig.JWT_SECRET) as JwtPayload;
    req.jwtPayload = payload;
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      logExpiredTokenRejection(req, token, error);
    } else {
      logger.warn(
        {
          type: 'auth_rejection',
          reason: 'invalid_signature',
          endpoint: req.path,
          ip_address: getClientIp(req),
        },
        'Authentication rejected: invalid signature'
      );
    }
    sendUnauthorized(res, 'Invalid or expired token');
  }
}
