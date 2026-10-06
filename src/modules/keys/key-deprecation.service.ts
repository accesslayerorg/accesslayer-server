// src/modules/keys/key-deprecation.service.ts
// Admin key deprecation with guaranteed holder buyback (#882).
//
// POST /keys/:keyId/deprecate marks a key deprecated, stores the guaranteed
// buyback price and window expiry, and requires a 2-of-3 admin multisig
// (Ed25519 signatures over a canonical deprecation message). Holders are
// notified through the notification feed (see KEY_DEPRECATED in
// notification.service.ts).
//
// POST /keys/:keyId/buyback lets a holder exit the full position at the
// guaranteed price until the expiry — after which the request is rejected
// with 410 Gone. The balance decrement and payment record are written in a
// single Prisma transaction.

import { createHash } from 'crypto';
import { Keypair } from '@stellar/stellar-base';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { envConfig } from '../../config';
import { emitAuditEvent } from '../../utils/audit.utils';
import { getRedis } from '../../utils/redis.utils';
import { createAuditEntry } from '../admin/audit-log.service';
import { KeyNotFoundError } from './key-fees.service';
import { NOTIFICATION_TYPES, REDIS_KEYS } from '../../constants/notifications.constants';

/** Minimum (and default target) number of admin signatures for deprecation. */
export const DEPRECATION_MULTISIG_THRESHOLD = 2;
/** The admin quorum size the threshold is expressed against (2 of 3). */
export const DEPRECATION_MULTISIG_SET_SIZE = 3;

export interface DeprecationSignature {
   wallet: string;
   signature: string;
}

export class KeyAlreadyDeprecatedError extends Error {
   constructor(keyId: string) {
      super(`Key is already deprecated: ${keyId}`);
      this.name = 'KeyAlreadyDeprecatedError';
   }
}

export class KeyNotDeprecatedError extends Error {
   constructor(keyId: string) {
      super(`Key is not deprecated: ${keyId}`);
      this.name = 'KeyNotDeprecatedError';
   }
}

export class BuybackWindowClosedError extends Error {
   constructor(keyId: string, expiresAt: Date) {
      super(
         `Buyback window for key ${keyId} closed at ${expiresAt.toISOString()}`
      );
      this.name = 'BuybackWindowClosedError';
      this.expiresAt = expiresAt;
   }
   readonly expiresAt: Date;
}

export class BuybackPriceNotSetError extends Error {
   constructor(keyId: string) {
      super(`No buyback price configured for key: ${keyId}`);
      this.name = 'BuybackPriceNotSetError';
   }
}

export class InsufficientPositionError extends Error {
   constructor() {
      super('No key balance available for buyback');
      this.name = 'InsufficientPositionError';
   }
}

export class MultisigVerificationError extends Error {
   constructor(message: string) {
      super(message);
      this.name = 'MultisigVerificationError';
   }
}

/**
 * Canonical message each admin signs for a deprecation:
 *   SHA256("deprecate:<keyId>:<buybackPriceXlm>:<buybackExpiresAt>")
 * Binds the signature to the exact deprecation payload (no replay across
 * keys or price/expiry changes).
 */
export function buildDeprecationCanonicalMessage(
   keyId: string,
   buybackPriceXlm: string,
   buybackExpiresAt: string
): Buffer {
   const payload = `deprecate:${keyId}:${buybackPriceXlm}:${buybackExpiresAt}`;
   return createHash('sha256').update(payload, 'utf8').digest();
}

/** Parse the configured 2-of-3 admin quorum from ADMIN_MULTISIG_WALLETS. */
export function parseMultisigAdminWallets(): string[] {
   const raw = envConfig.ADMIN_MULTISIG_WALLETS;
   if (!raw) return [];
   return raw
      .split(',')
      .map(wallet => wallet.trim())
      .filter(wallet => wallet.length > 0);
}

const STELLAR_ADDRESS_PATTERN = /^G[A-Z2-7]{55}$/;

/**
 * Verify the submitted deprecation signatures against the canonical
 * message. Enforces the 2-of-3 multisig threshold: at least two distinct
 * valid signatures, each from a wallet in the configured admin quorum when
 * ADMIN_MULTISIG_WALLETS is set.
 *
 * @throws {MultisigVerificationError} on invalid, duplicate-threshold, or
 * non-admin signers.
 */
export function verifyDeprecationSignatures(params: {
   keyId: string;
   buybackPriceXlm: string;
   buybackExpiresAt: string;
   signatures: DeprecationSignature[];
}): { validWallets: string[] } {
   const message = buildDeprecationCanonicalMessage(
      params.keyId,
      params.buybackPriceXlm,
      params.buybackExpiresAt
   );
   const adminWallets = parseMultisigAdminWallets();
   const adminSet = new Set(adminWallets.map(wallet => wallet.toLowerCase()));

   const seen = new Set<string>();
   const validWallets: string[] = [];

   for (const { wallet, signature } of params.signatures) {
      const normalized = wallet.trim();
      const lower = normalized.toLowerCase();
      if (seen.has(lower)) {
         continue; // duplicate wallet signatures count once
      }

      if (!STELLAR_ADDRESS_PATTERN.test(normalized)) {
         throw new MultisigVerificationError(
            `Invalid admin wallet address: ${normalized}`
         );
      }
      if (adminSet.size > 0 && !adminSet.has(lower)) {
         throw new MultisigVerificationError(
            `Signer ${normalized} is not a configured admin`
         );
      }

      let verified = false;
      try {
         const signatureBuffer = Buffer.from(signature, 'base64');
         if (signatureBuffer.length === 64) {
            verified = Keypair.fromPublicKey(normalized).verify(
               message,
               signatureBuffer
            );
         }
      } catch {
         verified = false;
      }
      if (!verified) {
         throw new MultisigVerificationError(
            `Invalid deprecation signature from ${normalized}`
         );
      }

      seen.add(lower);
      validWallets.push(normalized);
   }

   if (adminSet.size > 0 && adminSet.size !== DEPRECATION_MULTISIG_SET_SIZE) {
      throw new MultisigVerificationError(
         `ADMIN_MULTISIG_WALLETS must contain exactly ${DEPRECATION_MULTISIG_SET_SIZE} wallets (got ${adminSet.size})`
      );
   }
   if (validWallets.length < DEPRECATION_MULTISIG_THRESHOLD) {
      throw new MultisigVerificationError(
         `Deprecation requires ${DEPRECATION_MULTISIG_THRESHOLD} of ${adminSet.size || DEPRECATION_MULTISIG_SET_SIZE} admin signatures; got ${validWallets.length}`
      );
   }

   return { validWallets };
}

export interface DeprecateKeyInput {
   keyId: string;
   /** Guaranteed buyback price per key, as a positive decimal string (XLM). */
   buybackPriceXlm: string;
   buybackExpiresAt: Date;
   signatures: DeprecationSignature[];
   actor: string;
}

export interface DeprecateKeyResult {
   keyId: string;
   deprecatedAt: Date;
   buybackPriceXlm: string;
   buybackExpiresAt: Date;
   holdersNotified: number;
   signers: string[];
}

export interface KeySunsetNotificationDispatchInput {
   keyId: string;
   eventId: string;
   sunsetDeadline: Date;
   buybackPriceXlm: string;
   actor?: string;
   maxRetries?: number;
   notificationDispatcher?: (payload: {
      eventType: string;
      keyId: string;
      holderAddress: string;
      eventId: string;
      sunsetDeadline: string;
      buybackPriceXlm: string;
   }) => Promise<void>;
}

export interface KeySunsetDispatchLogEntry {
   holderAddress: string;
   status: 'delivered' | 'failed' | 'skipped';
   attempts: number;
   lastError?: string;
}

export interface KeySunsetNotificationDispatchResult {
   keyId: string;
   eventId: string;
   holdersNotified: number;
   deliveredCount: number;
   failedCount: number;
   skippedCount: number;
   dispatches: KeySunsetDispatchLogEntry[];
}

async function deliverKeySunsetNotification(payload: {
   eventType: string;
   keyId: string;
   holderAddress: string;
   eventId: string;
   sunsetDeadline: string;
   buybackPriceXlm: string;
}): Promise<void> {
   logger.info(
      {
         eventType: payload.eventType,
         keyId: payload.keyId,
         holderAddress: payload.holderAddress,
         eventId: payload.eventId,
         sunsetDeadline: payload.sunsetDeadline,
         buybackPriceXlm: payload.buybackPriceXlm,
      },
      'Key sunset notification dispatched to holder'
   );
}

export async function dispatchKeySunsetNotifications(
   input: KeySunsetNotificationDispatchInput
): Promise<KeySunsetNotificationDispatchResult> {
   const holders = await prisma.keyOwnership.findMany({
      where: {
         creatorId: input.keyId,
         balance: { gt: 0 },
      },
      select: {
         ownerAddress: true,
      },
   });

   const maxRetries = input.maxRetries ?? 3;
   const redis = getRedis();
   const dedupeKey = REDIS_KEYS.keySunsetEvent(input.eventId);
   let deliveredCount = 0;
   let failedCount = 0;
   let skippedCount = 0;
   const dispatches: KeySunsetDispatchLogEntry[] = [];

   for (const holder of holders) {
      const holderAddress = holder.ownerAddress;
      if (redis) {
         const added = await redis.sadd(dedupeKey, holderAddress);
         if (added === 0) {
            skippedCount += 1;
            dispatches.push({
               holderAddress,
               status: 'skipped',
               attempts: 0,
            });
            continue;
         }
      }

      let attempts = 0;
      let lastError: string | undefined;
      let status: 'delivered' | 'failed' = 'failed';

      for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
         attempts = attempt;
         try {
            const payload = {
               eventType: NOTIFICATION_TYPES.KEY_SUNSET_FLAGGED,
               keyId: input.keyId,
               holderAddress,
               eventId: input.eventId,
               sunsetDeadline: input.sunsetDeadline.toISOString(),
               buybackPriceXlm: input.buybackPriceXlm,
            };
            await (input.notificationDispatcher ?? deliverKeySunsetNotification)(
               payload
            );
            status = 'delivered';
            deliveredCount += 1;
            break;
         } catch (error) {
            const message =
               error instanceof Error ? error.message : String(error);
            lastError = message;
            logger.warn(
               {
                  keyId: input.keyId,
                  holderAddress,
                  eventId: input.eventId,
                  attempt,
                  maxRetries,
                  error: message,
               },
               'Key sunset notification delivery failed; retrying'
            );
            if (attempt === maxRetries) {
               failedCount += 1;
            }
         }
      }

      const dispatchLog = {
         holderAddress,
         status,
         attempts,
         ...(lastError ? { lastError } : {}),
      };
      dispatches.push(dispatchLog);

      await prisma.activityLog.create({
         data: {
            type: 'key_sunset_flagged_notification',
            actor: input.actor ?? 'system',
            keyId: input.keyId,
            target: holderAddress,
            payload: {
               eventId: input.eventId,
               holderAddress,
               keyId: input.keyId,
               status,
               attempts,
               lastError,
               sunsetDeadline: input.sunsetDeadline.toISOString(),
               buybackPriceXlm: input.buybackPriceXlm,
            },
         },
      });
   }

   return {
      keyId: input.keyId,
      eventId: input.eventId,
      holdersNotified: holders.length,
      deliveredCount,
      failedCount,
      skippedCount,
      dispatches,
   };
}

export interface KeyDeprecationNotificationDispatchInput {
   keyId: string;
   eventId: string;
   reason?: string;
   successorKeyId?: string;
   maxRetries?: number;
   notificationDispatcher?: (payload: {
      eventType: string;
      keyId: string;
      holderAddress: string;
      eventId: string;
      reason: string | null;
      successorKeyId: string | null;
   }) => Promise<void>;
}

export interface KeyDeprecationNotificationDispatchResult {
   keyId: string;
   eventId: string;
   holdersNotified: number;
   deliveredCount: number;
   failedCount: number;
   skippedCount: number;
}

async function deliverKeyDeprecationNotification(payload: {
   eventType: string;
   keyId: string;
   holderAddress: string;
   eventId: string;
   reason: string | null;
   successorKeyId: string | null;
}): Promise<void> {
   logger.info(
      payload,
      'Key deprecation notification dispatched to holder'
   );
}

/**
 * Notify every current holder of a key that it has been deprecated (e.g. by
 * an indexed contract event). Mirrors {@link dispatchKeySunsetNotifications}
 * but is not tied to a guaranteed-buyback payload, and dedupes per
 * `eventId` via Redis so replaying the same chain event during re-indexing
 * never notifies a holder twice.
 */
export async function dispatchKeyDeprecationNotifications(
   input: KeyDeprecationNotificationDispatchInput
): Promise<KeyDeprecationNotificationDispatchResult> {
   const holders = await prisma.keyOwnership.findMany({
      where: {
         creatorId: input.keyId,
         balance: { gt: 0 },
      },
      select: {
         ownerAddress: true,
      },
   });

   const maxRetries = input.maxRetries ?? 3;
   const redis = getRedis();
   const dedupeKey = REDIS_KEYS.keyDeprecationEvent(input.eventId);
   const reason = input.reason ?? null;
   const successorKeyId = input.successorKeyId ?? null;
   let deliveredCount = 0;
   let failedCount = 0;
   let skippedCount = 0;

   for (const holder of holders) {
      const holderAddress = holder.ownerAddress;
      if (redis) {
         const added = await redis.sadd(dedupeKey, holderAddress);
         if (added === 0) {
            skippedCount += 1;
            continue;
         }
      }

      let attempts = 0;
      let lastError: string | undefined;
      let status: 'delivered' | 'failed' = 'failed';

      for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
         attempts = attempt;
         try {
            await (input.notificationDispatcher ?? deliverKeyDeprecationNotification)({
               eventType: NOTIFICATION_TYPES.KEY_DEPRECATED,
               keyId: input.keyId,
               holderAddress,
               eventId: input.eventId,
               reason,
               successorKeyId,
            });
            status = 'delivered';
            deliveredCount += 1;
            break;
         } catch (error) {
            const message =
               error instanceof Error ? error.message : String(error);
            lastError = message;
            logger.warn(
               {
                  keyId: input.keyId,
                  holderAddress,
                  eventId: input.eventId,
                  attempt,
                  maxRetries,
                  error: message,
               },
               'Key deprecation notification delivery failed; retrying'
            );
            if (attempt === maxRetries) {
               failedCount += 1;
            }
         }
      }

      await prisma.activityLog.create({
         data: {
            type: 'key_deprecated_notification',
            actor: 'system',
            keyId: input.keyId,
            target: holderAddress,
            payload: {
               eventId: input.eventId,
               holderAddress,
               keyId: input.keyId,
               status,
               attempts,
               lastError,
               reason,
               successorKeyId,
            },
         },
      });
   }

   return {
      keyId: input.keyId,
      eventId: input.eventId,
      holdersNotified: holders.length,
      deliveredCount,
      failedCount,
      skippedCount,
   };
}

export interface KeyDeprecationSuccessorSummary {
   id: string;
   name: string | null;
   avatarUrl: string | null;
   currentPrice: string | null;
}

export interface KeyDeprecationStatusResult {
   keyId: string;
   status: 'active' | 'deprecated';
   reason: string | null;
   deprecatedAt: string | null;
   successor: KeyDeprecationSuccessorSummary | null;
}

/**
 * Read-only deprecation status for a key: whether it is deprecated, why,
 * when, and — when a successor key was designated — a summary of it.
 * Backs GET /keys/:keyId/deprecation.
 */
export async function getKeyDeprecationStatus(
   keyId: string
): Promise<KeyDeprecationStatusResult> {
   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: {
         id: true,
         deprecatedAt: true,
         reason: true,
         successorKeyId: true,
      },
   });
   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   let successor: KeyDeprecationSuccessorSummary | null = null;
   if (creator.successorKeyId) {
      const successorProfile = await prisma.creatorProfile.findUnique({
         where: { id: creator.successorKeyId },
         select: {
            id: true,
            displayName: true,
            avatarUrl: true,
            priceSnapshot: { select: { currentPrice: true } },
         },
      });
      if (successorProfile) {
         successor = {
            id: successorProfile.id,
            name: successorProfile.displayName ?? null,
            avatarUrl: successorProfile.avatarUrl ?? null,
            currentPrice: successorProfile.priceSnapshot
               ? successorProfile.priceSnapshot.currentPrice.toString()
               : null,
         };
      }
   }

   return {
      keyId: creator.id,
      status: creator.deprecatedAt ? 'deprecated' : 'active',
      reason: creator.reason ?? null,
      deprecatedAt: creator.deprecatedAt
         ? creator.deprecatedAt.toISOString()
         : null,
      successor,
   };
}

/**
 * Deprecate a key: verify the 2-of-3 multisig, store the buyback price and
 * expiry on the key record, and notify all holders (derived KEY_DEPRECATED
 * notifications for every wallet holding the key). Audited end to end.
 */
export async function deprecateKey(
   input: DeprecateKeyInput
): Promise<DeprecateKeyResult> {
   const buybackExpiresAtIso = input.buybackExpiresAt.toISOString();
   const { validWallets } = verifyDeprecationSignatures({
      keyId: input.keyId,
      buybackPriceXlm: input.buybackPriceXlm,
      buybackExpiresAt: buybackExpiresAtIso,
      signatures: input.signatures,
   });

   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: input.keyId }, { handle: input.keyId }] },
      select: { id: true, deprecatedAt: true },
   });
   if (!creator) {
      throw new KeyNotFoundError(input.keyId);
   }
   if (creator.deprecatedAt) {
      throw new KeyAlreadyDeprecatedError(creator.id);
   }

   const holderCount = await prisma.keyOwnership.count({
      where: { creatorId: creator.id, balance: { gt: 0 } },
   });

   const deprecatedAt = new Date();
   const metadata = {
      keyId: creator.id,
      buybackPriceXlm: input.buybackPriceXlm,
      buybackExpiresAt: buybackExpiresAtIso,
      signers: validWallets,
      holdersNotified: holderCount,
   };

   await prisma.$transaction([
      prisma.creatorProfile.update({
         where: { id: creator.id },
         data: {
            deprecatedAt,
            buybackPriceXlm: input.buybackPriceXlm,
            buybackExpiresAt: input.buybackExpiresAt,
         },
      }),
      prisma.activityLog.create({
         data: {
            type: 'deprecate',
            actor: input.actor,
            keyId: creator.id,
            payload: metadata,
         },
      }),
   ]);

   await emitAuditEvent({
      actor: input.actor,
      action: 'key_deprecated',
      target: 'CreatorProfile',
      targetId: creator.id,
      metadata,
   });
   await createAuditEntry({
      actorWallet: input.actor,
      actionType: 'key_deprecated',
      targetId: creator.id,
      payload: metadata,
   });

   const sunsetEventId = `key_sunset:${creator.id}:${deprecatedAt.toISOString()}`;
   const dispatch = await dispatchKeySunsetNotifications({
      keyId: creator.id,
      eventId: sunsetEventId,
      sunsetDeadline: input.buybackExpiresAt,
      buybackPriceXlm: input.buybackPriceXlm,
      actor: input.actor,
   });

   logger.info(
      {
         keyId: creator.id,
         holdersNotified: holderCount,
         buybackPriceXlm: input.buybackPriceXlm,
         buybackExpiresAt: buybackExpiresAtIso,
         signers: validWallets,
         dispatched: dispatch.deliveredCount,
         failed: dispatch.failedCount,
         skipped: dispatch.skippedCount,
      },
      'Key deprecated; all holders notified via notification feed'
   );

   return {
      keyId: creator.id,
      deprecatedAt,
      buybackPriceXlm: input.buybackPriceXlm,
      buybackExpiresAt: input.buybackExpiresAt,
      holdersNotified: holderCount,
      signers: validWallets,
   };
}

export interface BuybackResult {
   buybackId: string;
   keyId: string;
   holderAddress: string;
   quantity: string;
   pricePerKeyXlm: string;
   amountXlm: string;
   balanceAfter: string;
   circulatingSupplyAfter: string;
   processedAt: Date;
}

/**
 * Process a holder buyback on a deprecated key at the guaranteed price.
 *
 * - Rejects when the key is not deprecated (409) or the window expired (410).
 * - Zeroes the holder balance, decrements circulating supply, and writes the
 *   KeyBuyback payment record in one transaction (atomic exit).
 *
 * TODO: submit the XLM payout via the Stellar SDK; on-chain failure should
 * return 502 before this point. The DB payment record is the settlement
 * source of truth until then.
 */
export async function processBuyback(
   keyId: string,
   holderAddress: string
): Promise<BuybackResult> {
   return prisma.$transaction(async tx => {
      const creator = await tx.creatorProfile.findFirst({
         where: { OR: [{ id: keyId }, { handle: keyId }] },
      });
      if (!creator) {
         throw new KeyNotFoundError(keyId);
      }
      if (!creator.deprecatedAt) {
         throw new KeyNotDeprecatedError(creator.id);
      }
      if (
         creator.buybackExpiresAt &&
         new Date() > creator.buybackExpiresAt
      ) {
         throw new BuybackWindowClosedError(
            creator.id,
            creator.buybackExpiresAt
         );
      }
      const pricePerKeyXlm = Number(creator.buybackPriceXlm ?? 0);
      if (!(pricePerKeyXlm > 0)) {
         throw new BuybackPriceNotSetError(creator.id);
      }

      const ownership = await tx.keyOwnership.findUnique({
         where: {
            ownerAddress_creatorId: {
               ownerAddress: holderAddress,
               creatorId: creator.id,
            },
         },
      });
      const balance = Number(ownership?.balance ?? 0);
      if (balance <= 0 || !ownership) {
         throw new InsufficientPositionError();
      }

      const amountXlm = balance * pricePerKeyXlm;
      const currentSupply = Number(creator.circulatingSupply);
      const newSupply = Math.max(0, currentSupply - balance);

      const buyback = await tx.keyBuyback.create({
         data: {
            keyId: creator.id,
            holderAddress,
            quantity: balance,
            pricePerKeyXlm,
            amountXlm,
         },
      });

      await tx.keyOwnership.update({
         where: { id: ownership.id },
         data: { balance: 0, costBasis: 0 },
      });
      await tx.creatorProfile.update({
         where: { id: creator.id },
         data: { circulatingSupply: newSupply },
      });
      await tx.activityLog.create({
         data: {
            type: 'buyback',
            actor: holderAddress,
            keyId: creator.id,
            amount: amountXlm,
            payload: {
               buybackId: buyback.id,
               quantity: balance,
               pricePerKeyXlm,
               amountXlm,
               balanceAfter: 0,
               circulatingSupplyAfter: newSupply,
            },
         },
      });

      const metadata = {
         keyId: creator.id,
         buybackId: buyback.id,
         quantity: balance,
         pricePerKeyXlm,
         amountXlm,
      };
      await emitAuditEvent({
         actor: holderAddress,
         action: 'key_buyback',
         target: 'KeyBuyback',
         targetId: buyback.id,
         metadata,
      });
      await createAuditEntry({
         actorWallet: holderAddress,
         actionType: 'key_buyback',
         targetId: creator.id,
         payload: metadata,
      });

      logger.info(
         {
            keyId: creator.id,
            holder: holderAddress,
            quantity: balance,
            amountXlm,
         },
         'Holder buyback processed at guaranteed price'
      );

      return {
         buybackId: buyback.id,
         keyId: creator.id,
         holderAddress,
         quantity: balance.toString(),
         pricePerKeyXlm: pricePerKeyXlm.toString(),
         amountXlm: amountXlm.toString(),
         balanceAfter: '0',
         circulatingSupplyAfter: newSupply.toString(),
         processedAt: buyback.processedAt,
      };
   });
}
