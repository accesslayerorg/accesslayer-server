// src/middlewares/internal-network.middleware.ts
// Restricts internal-only endpoints to private/loopback network callers or internal API key callers.

import { Request, Response, NextFunction } from 'express';
import { getClientIp } from '../utils/client-ip.utils';
import { sendForbidden } from '../utils/api-response.utils';
import { envConfig } from '../config';
import { extractBearerToken } from '../utils/jwt.utils';
import { logger } from '../utils/logger.utils';

function isInternalIpAddress(rawIp: string): boolean {
   if (!rawIp) return false;

   // Normalize IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1 -> 127.0.0.1)
   const ip = rawIp.replace(/^::ffff:/, '').trim();

   // Loopback
   if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') {
      return true;
   }
   if (ip.startsWith('127.')) {
      return true;
   }

   // 10.0.0.0/8
   if (ip.startsWith('10.')) {
      return true;
   }

   // 192.168.0.0/16
   if (ip.startsWith('192.168.')) {
      return true;
   }

   // 172.16.0.0/12 (172.16.x.x - 172.31.x.x)
   if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) {
      return true;
   }

   // IPv6 Unique-Local (fc00::/7 -> fc00: or fd00:)
   if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:')) {
      return true;
   }

   return false;
}

/**
 * Middleware that restricts route access to internal network calls
 * (loopback/private IP addresses or authorized internal service callers).
 */
export function requireInternalNetwork(
   req: Request,
   res: Response,
   next: NextFunction
): void {
   const clientIp = getClientIp(req);

   if (clientIp && isInternalIpAddress(clientIp)) {
      return next();
   }

   // Allow authorized internal service key bypass if presented
   const configuredKey =
      envConfig.INTERNAL_SERVICE_KEY ||
      process.env.INDEXER_API_KEY ||
      process.env.INTERNAL_API_KEY;

   const providedHeader =
      req.headers['x-api-key'] || req.headers['x-internal-service-key'];

   const providedKey =
      (Array.isArray(providedHeader) ? providedHeader[0] : providedHeader) ||
      extractBearerToken(req.headers.authorization);

   if (configuredKey && providedKey === configuredKey) {
      return next();
   }

   logger.warn(
      {
         client_ip: clientIp,
         path: req.originalUrl || req.path,
         method: req.method,
      },
      'Forbidden request to internal network endpoint'
   );

   sendForbidden(res, 'Access restricted to internal network');
}
