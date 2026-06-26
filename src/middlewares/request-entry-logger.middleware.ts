import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logger } from '../utils/logger.utils';

function maskIpToSubnet24(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  const parts = ip.split('.');
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }
  return ip;
}

export const requestEntryLoggerMiddleware = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  const requestId = (req as any).requestId ?? crypto.randomUUID();

  logger.info({
    type: 'request_entry',
    request_id: requestId,
    method: req.method,
    path: req.path,
    ip: maskIpToSubnet24((req as any).ip ?? req.socket?.remoteAddress),
    user_agent: req.headers['user-agent'],
  });

  next();
};
