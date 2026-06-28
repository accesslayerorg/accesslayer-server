// src/middlewares/stellar-signature.middleware.ts
// Middleware that verifies Stellar Ed25519 signatures on mutating routes.
// Prevents impersonation by requiring proof of wallet ownership.

import type { Request, Response, NextFunction } from 'express';
import { Keypair } from '@stellar/stellar-base';
import { createHash } from 'crypto';
import { StellarAddressSchema } from '../modules/wallet/wallet.schemas';
import { sendError } from '../utils/api-response.utils';
import { ErrorCode } from '../constants/error.constants';
import { logger } from '../utils/logger.utils';

export interface StellarSignedRequest extends Request {
  walletAddress?: string;
  signatureVerified?: boolean;
}

const SIGNATURE_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

function readHeader(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0]?.trim() || undefined;
  return typeof raw === 'string' ? raw.trim() || undefined : undefined;
}

/**
 * Builds the canonical message that the client must sign.
 * 
 * Format: SHA256(body_json + timestamp)
 * 
 * This prevents replay attacks (timestamp) and body tampering (body hash).
 */
function buildCanonicalMessage(body: unknown, timestamp: string): Buffer {
  const bodyJson = JSON.stringify(body);
  const payload = `${bodyJson}${timestamp}`;
  return createHash('sha256').update(payload, 'utf8').digest();
}

/**
 * Middleware that verifies Stellar Ed25519 signatures for mutating routes.
 * 
 * Required headers:
 * - x-wallet-address: Stellar public key (56 chars, starts with G)
 * - x-wallet-signature: Base64-encoded Ed25519 signature
 * - x-timestamp: Unix timestamp in milliseconds (must be within 5 min)
 * 
 * The signature must be computed over SHA256(body_json + timestamp).
 * 
 * On success, attaches `walletAddress` and `signatureVerified=true` to the request.
 * On failure, returns 401 (missing/expired) or 403 (invalid signature).
 */
export function requireStellarSignature() {
  return async (
    req: StellarSignedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const address = readHeader(req, 'x-wallet-address');
    const signature = readHeader(req, 'x-wallet-signature');
    const timestamp = readHeader(req, 'x-timestamp');

    if (!address || !signature || !timestamp) {
      sendError(
        res,
        401,
        ErrorCode.UNAUTHORIZED,
        'Missing required signature headers: x-wallet-address, x-wallet-signature, x-timestamp'
      );
      return;
    }

    // Validate wallet address format
    const addressValidation = StellarAddressSchema.safeParse(address);
    if (!addressValidation.success) {
      sendError(
        res,
        400,
        ErrorCode.BAD_REQUEST,
        'Invalid Stellar wallet address format',
        addressValidation.error.issues.map((issue) => ({
          field: 'x-wallet-address',
          message: issue.message,
        }))
      );
      return;
    }

    // Validate timestamp freshness
    const ts = parseInt(timestamp, 10);
    if (isNaN(ts)) {
      sendError(
        res,
        400,
        ErrorCode.BAD_REQUEST,
        'Invalid timestamp format — must be Unix milliseconds'
      );
      return;
    }

    const now = Date.now();
    const age = now - ts;
    if (age < 0 || age > SIGNATURE_TIMESTAMP_TOLERANCE_MS) {
      sendError(
        res,
        401,
        ErrorCode.UNAUTHORIZED,
        'Signature timestamp is invalid or expired (must be within 5 minutes)'
      );
      return;
    }

    // Build canonical message and verify signature
    try {
      const message = buildCanonicalMessage(req.body, timestamp);
      const signatureBuffer = Buffer.from(signature, 'base64');
      
      if (signatureBuffer.length !== 64) {
        sendError(
          res,
          400,
          ErrorCode.BAD_REQUEST,
          'Invalid signature format — Ed25519 signatures must be 64 bytes'
        );
        return;
      }

      const keypair = Keypair.fromPublicKey(address);
      const verified = keypair.verify(message, signatureBuffer);

      if (!verified) {
        logger.warn(
          { address, endpoint: req.path, requestId: req.requestId },
          'Stellar signature verification failed — signature mismatch'
        );
        sendError(
          res,
          403,
          ErrorCode.FORBIDDEN,
          'Invalid signature — the request body was tampered with or signed by the wrong key'
        );
        return;
      }

      req.walletAddress = address;
      req.signatureVerified = true;
      next();
    } catch (error) {
      logger.error(
        { error, address, endpoint: req.path, requestId: req.requestId },
        'Stellar signature verification exception'
      );
      sendError(
        res,
        500,
        ErrorCode.INTERNAL_ERROR,
        'Signature verification failed due to an internal error'
      );
    }
  };
}
