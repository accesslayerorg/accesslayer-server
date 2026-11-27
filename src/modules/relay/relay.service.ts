// src/modules/relay/relay.service.ts
// Service layer for the gasless meta-transaction relay flow (#1088).
//
// Responsibilities:
//   - Generate and reserve the next unused nonce for a wallet (5-minute TTL)
//   - Validate and consume a reservation when a signed payload is submitted
//   - Enforce per-wallet rate limiting (10 relay requests / wallet / minute)
//
// All side effects (Redis, on-chain submission, signature verification) go
// through injectable dependencies so the module can be tested in isolation.

import { envConfig } from '../../config';
import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';
import { getWalletNonce } from '../nonce/nonce.service';
import {
   RelayInvalidSignatureError,
   RelayNonceAlreadyUsedError,
   RelayNonceExpiredError,
   RelayNonceNotReservedError,
   RelaySubmissionError,
} from './relay.errors';
import type {
   RelayNonceReservation,
   RelayNonceResponse,
   RelayRateLimitInfo,
   RelaySigner,
   RelaySubmitResult,
   RelaySubmitter,
} from './relay.types';

const RELAY_NONCE_RESERVATION_TTL_SECONDS = 5 * 60; // 5 minutes
const RELAY_RATE_LIMIT_WINDOW_SECONDS = 60;
const RELAY_RATE_LIMIT_MAX_REQUESTS = 10;
const RELAY_CONSUMED_NONCE_TTL_SECONDS = 86400; // 24 hours

export function relayNonceReservationKey(wallet: string): string {
   return `relay:nonce:reserved:${wallet}`;
}

export function relayRateLimitKey(wallet: string): string {
   return `relay:ratelimit:${wallet}`;
}

export function relayConsumedNonceKey(wallet: string, nonce: number): string {
   return `relay:nonce:consumed:${wallet}:${nonce}`;
}

function nowMs(): number {
   return Date.now();
}

/**
 * Default signature verifier. Validates that `signature` is an ed25519
 * signature from the wallet's Stellar public key over the raw transaction
 * payload bytes. Falls back to `false` (reject) when Stellar primitives are
 * unavailable or the inputs are malformed, so invalid signatures never result
 * in an on-chain submission.
 */
class DefaultRelaySigner implements RelaySigner {
   async verifySignature(
      wallet: string,
      signature: string,
      txParams: string
   ): Promise<boolean> {
      try {
         // Imported statically at module load via the namespace import below.
         const { StrKey, verify } = await import('@stellar/stellar-base');
         if (!StrKey.isValidEd25519PublicKey(wallet)) {
            return false;
         }
         const publicKey = StrKey.decodeEd25519PublicKey(wallet);
         const data = Buffer.from(txParams, 'utf8');
         let signatureBytes: Buffer;
         try {
            signatureBytes = Buffer.from(signature, 'base64');
         } catch {
            signatureBytes = Buffer.from(signature, 'hex');
         }
         return verify(data, signatureBytes, publicKey);
      } catch (error) {
         logger.warn({ error, wallet }, 'Relay signature verification errored');
         return false;
      }
   }
}

/**
 * Default on-chain submitter. Forwards the signed payload to the configured
 * Soroban RPC `sendTransaction` method and returns the transaction hash.
 * Fails closed (throws RelaySubmissionError) when the RPC is not configured
 * or the submission is rejected, so a relay never succeeds without an
 * on-chain transaction hash.
 */
class DefaultRelaySubmitter implements RelaySubmitter {
   async submitTransaction(signedPayload: string): Promise<{ txHash: string }> {
      const rpcUrl = (envConfig as any).STELLAR_SOROBAN_RPC_URL;
      if (!rpcUrl) {
         throw new RelaySubmissionError(
            'Stellar Soroban RPC URL is not configured'
         );
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      try {
         const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
               jsonrpc: '2.0',
               id: 'relay-submit-transaction',
               method: 'sendTransaction',
               params: { transaction: signedPayload },
            }),
            signal: controller.signal,
         });

         const envelope = (await response.json()) as {
            error?: { message?: string };
            result?: { hash?: string };
         };

         if (!response.ok || envelope.error) {
            throw new RelaySubmissionError(
               envelope.error?.message ??
                  `Soroban RPC returned HTTP ${response.status}`
            );
         }

         const txHash = envelope.result?.hash;
         if (!txHash || typeof txHash !== 'string') {
            throw new RelaySubmissionError(
               'Soroban RPC did not return a transaction hash'
            );
         }

         return { txHash };
      } catch (error) {
         if (error instanceof RelaySubmissionError) {
            throw error;
         }
         throw new RelaySubmissionError(error);
      } finally {
         clearTimeout(timeout);
      }
   }
}

const defaultSigner = new DefaultRelaySigner();
const defaultSubmitter = new DefaultRelaySubmitter();

/**
 * Returns the next unused nonce for a wallet and reserves it for
 * `RELAY_NONCE_RESERVATION_TTL_SECONDS` (5 minutes).
 *
 * If an active, non-expired reservation already exists for the wallet it is
 * returned as-is; otherwise a fresh reservation is created from the wallet's
 * current on-chain nonce (tracked state falls back to 0 when no contract is
 * configured).
 */
async function reserveWalletNonce(
   wallet: string
): Promise<RelayNonceReservation> {
   const existing = await cacheGetJson<RelayNonceReservation>(
      relayNonceReservationKey(wallet)
   );

   if (existing) {
      if (new Date(existing.expiresAt).getTime() > nowMs()) {
         return existing;
      }
      // Reservation expired: free it so the nonce can be re-reserved.
      await cacheInvalidate(relayNonceReservationKey(wallet));
      logger.info(
         { wallet, nonce: existing.nonce },
         'Expired relay nonce reservation freed'
      );
   }

   const currentNonce = await getWalletNonce(wallet);
   const nonce = currentNonce.nonce;
   const reservedAt = new Date();
   const expiresAt = new Date(
      reservedAt.getTime() + RELAY_NONCE_RESERVATION_TTL_SECONDS * 1000
   );

   const reservation: RelayNonceReservation = {
      wallet,
      nonce,
      reservedAt: reservedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
   };

   await cacheSetJson(
      relayNonceReservationKey(wallet),
      reservation,
      RELAY_NONCE_RESERVATION_TTL_SECONDS
   );

   logger.info(
      { wallet, nonce, expiresAt: expiresAt.toISOString() },
      'Reserved relay nonce for wallet'
   );

   return reservation;
}

/**
 * Converts a reservation into the HTTP response shape for GET /relay/nonce/:wallet.
 */
function reservationToResponse(
   reservation: RelayNonceReservation
): RelayNonceResponse {
   const ttlSeconds = Math.max(
      0,
      Math.ceil((new Date(reservation.expiresAt).getTime() - nowMs()) / 1000)
   );
   return {
      wallet: reservation.wallet,
      nonce: reservation.nonce,
      reserved: ttlSeconds > 0,
      expiresInSeconds: ttlSeconds,
      expiresAt: reservation.expiresAt,
   };
}

/**
 * Checks the per-wallet relay rate limit (10 requests per minute).
 * Returns whether the request is allowed plus limit/remaining/reset metadata.
 */
async function checkRelayRateLimit(
   wallet: string
): Promise<RelayRateLimitInfo> {
   const key = relayRateLimitKey(wallet);
   const current = (await cacheGetJson<{ count: number }>(key)) ?? {
      count: 0,
   };
   const count = current.count;

   if (count >= RELAY_RATE_LIMIT_MAX_REQUESTS) {
      return {
         allowed: false,
         limit: RELAY_RATE_LIMIT_MAX_REQUESTS,
         remaining: 0,
         resetInSeconds: RELAY_RATE_LIMIT_WINDOW_SECONDS,
      };
   }

   const nextCount = count + 1;
   await cacheSetJson(
      key,
      { count: nextCount, wallet, updatedAt: new Date().toISOString() },
      RELAY_RATE_LIMIT_WINDOW_SECONDS
   );

   return {
      allowed: true,
      limit: RELAY_RATE_LIMIT_MAX_REQUESTS,
      remaining: Math.max(0, RELAY_RATE_LIMIT_MAX_REQUESTS - nextCount),
      resetInSeconds: RELAY_RATE_LIMIT_WINDOW_SECONDS,
   };
}

/**
 * Validates and consumes a nonce reservation, verifies the signature, then
 * submits the transaction on-chain. Returns the transaction hash on success.
 *
 * Rejects (in order):
 *   - 404 when no active reservation exists for the (wallet, nonce)
 *   - 410 when the reservation has expired
 *   - 400 when the signature does not validate
 *   - 502 when on-chain submission fails
 */
async function submitRelayTransaction(
   wallet: string,
   nonce: number,
   signature: string,
   txParams: string,
   signer: RelaySigner = defaultSigner,
   submitter: RelaySubmitter = defaultSubmitter
): Promise<RelaySubmitResult> {
   const reservation = await cacheGetJson<RelayNonceReservation>(
      relayNonceReservationKey(wallet)
   );

   if (!reservation) {
      throw new RelayNonceNotReservedError(wallet, nonce);
   }

   if (reservation.nonce !== nonce) {
      throw new RelayNonceNotReservedError(wallet, nonce);
   }

   if (new Date(reservation.expiresAt).getTime() <= nowMs()) {
      throw new RelayNonceExpiredError(wallet, nonce);
   }

   const signatureValid = await signer.verifySignature(
      wallet,
      signature,
      txParams
   );
   if (!signatureValid) {
      throw new RelayInvalidSignatureError();
   }

   // Mark the nonce as consumed so the same reservation cannot be replayed.
   const consumedKey = relayConsumedNonceKey(wallet, nonce);
   const alreadyConsumed = await cacheGetJson<{ consumedAt: string }>(
      consumedKey
   );
   if (alreadyConsumed) {
      throw new RelayNonceAlreadyUsedError(wallet, nonce);
   }
   await cacheSetJson(
      consumedKey,
      { wallet, nonce, consumedAt: new Date().toISOString() },
      RELAY_CONSUMED_NONCE_TTL_SECONDS
   );
   // Release the reservation now that it has been consumed.
   await cacheInvalidate(relayNonceReservationKey(wallet));

   const { txHash } = await submitter.submitTransaction(txParams);

   logger.info({ wallet, nonce, txHash }, 'Relay transaction submitted');

   return {
      wallet,
      nonce,
      txHash,
   };
}

export {
   reserveWalletNonce,
   submitRelayTransaction,
   checkRelayRateLimit,
   reservationToResponse,
   DefaultRelaySigner,
   DefaultRelaySubmitter,
   defaultSigner,
   defaultSubmitter,
   RELAY_NONCE_RESERVATION_TTL_SECONDS,
   RELAY_RATE_LIMIT_MAX_REQUESTS,
   RELAY_RATE_LIMIT_WINDOW_SECONDS,
};
