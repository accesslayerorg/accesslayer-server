import type { Request, Response, NextFunction } from 'express';
import { Keypair } from '@stellar/stellar-base';
import { StellarAddressSchema } from '../wallet/wallet.schemas';
import { sendError } from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { createHash } from 'crypto';
import { parseCreatorId } from '../../utils/creator-id.utils';

export interface WalletSignedRequest extends Request {
  walletAddress?: string;
  creatorId?: string;
}

const SIGNATURE_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

function readHeader(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0]?.trim() || undefined;
  return typeof raw === 'string' ? raw.trim() || undefined : undefined;
}

function buildMessage(
  method: string,
  path: string,
  creatorId: string,
  timestamp: string
): Buffer {
  const payload = `${method.toUpperCase()}:${path}:${creatorId}:${timestamp}`;
  return createHash('sha256').update(payload, 'utf8').digest();
}

export function requireWalletSignature() {
  return async (
    req: WalletSignedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const address = readHeader(req, 'x-wallet-address');
    const signature = readHeader(req, 'x-signature');
    const timestamp = readHeader(req, 'x-timestamp');

    if (!address || !signature || !timestamp) {
      sendError(
        res,
        401,
        ErrorCode.UNAUTHORIZED,
        'Missing required headers: x-wallet-address, x-signature, x-timestamp'
      );
      return;
    }

    const addressValidation = StellarAddressSchema.safeParse(address);
    if (!addressValidation.success) {
      sendError(
        res,
        400,
        ErrorCode.BAD_REQUEST,
        'Invalid wallet address format'
      );
      return;
    }

    const ts = parseInt(timestamp, 10);
    if (isNaN(ts) || Date.now() - ts > SIGNATURE_TIMESTAMP_TOLERANCE_MS) {
      sendError(
        res,
        401,
        ErrorCode.UNAUTHORIZED,
        'Signature timestamp is invalid or expired'
      );
      return;
    }

    let creatorId: string;
    try {
      const rawId = req.params.id;
      creatorId = String(parseCreatorId(Array.isArray(rawId) ? rawId[0] : rawId));
    } catch {
      sendError(res, 400, ErrorCode.BAD_REQUEST, 'Creator ID must be a positive integer');
      return;
    }

    try {
      const creatorProfile = await prisma.creatorProfile.findUnique({
        where: { id: creatorId },
        select: { id: true },
      });

      if (!creatorProfile) {
        sendError(res, 404, ErrorCode.NOT_FOUND, 'Creator not found');
        return;
      }

      const message = buildMessage(req.method, req.originalUrl, creatorId, timestamp);
      const signatureBuffer = Buffer.from(signature, 'base64');
      const keypair = Keypair.fromPublicKey(address);
      const verified = keypair.verify(message, signatureBuffer);

      if (!verified) {
        sendError(
          res,
          403,
          ErrorCode.FORBIDDEN,
          'Invalid signature — wallet does not own this creator'
        );
        return;
      }
    } catch (error) {
      logger.error({ error, address, creatorId }, 'Signature verification failed');
      sendError(
        res,
        403,
        ErrorCode.FORBIDDEN,
        'Signature verification failed'
      );
      return;
    }

    req.walletAddress = address;
    req.creatorId = creatorId;
    next();
  };
}
