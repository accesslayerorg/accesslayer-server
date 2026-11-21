// src/modules/keys/price-velocity-breaker.service.ts
// Off-chain price velocity circuit breaker for creator keys (#1195).
//
// After each indexed trade the key's price is compared with its price
// `windowSize` trades earlier:
//
//    velocity = (current_price - price_N_trades_ago) / price_N_trades_ago * 100
//
// When |velocity| exceeds the configured threshold (a spike or a crash), the
// key's trading is paused at once, a PriceVelocityBreakerTrip row is written,
// and a `circuit_breaker_triggered` event is emitted. Trading only resumes
// through PUT /keys/:keyId/circuit-breaker/reset, which needs an admin JWT and
// an Ed25519 signature from a wallet in ADMIN_MULTISIG_WALLETS.

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { Keypair } from '@stellar/stellar-base';
import { envConfig } from '../../config';
import { logger } from '../../utils/logger.utils';
import { emitAuditEvent } from '../../utils/audit.utils';

export const CIRCUIT_BREAKER_TRIGGERED_EVENT = 'circuit_breaker_triggered';
export const CIRCUIT_BREAKER_RESET_EVENT = 'circuit_breaker_reset';

export const PRICE_VELOCITY_TRIP_STATUS = {
   TRIPPED: 'tripped',
   RESET: 'reset',
} as const;

/** Signatures older than this are rejected, matching requireStellarSignature. */
export const RESET_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

export interface PriceVelocityConfig {
   thresholdPct: number;
   windowSize: number;
}

export interface VelocityEvaluation {
   /** Signed percentage move; null when there are not enough trades yet. */
   velocityPct: number | null;
   thresholdPct: number;
   windowSize: number;
   currentPrice: string | null;
   referencePrice: string | null;
   triggered: boolean;
}

export interface CircuitBreakerTriggeredEvent {
   type: typeof CIRCUIT_BREAKER_TRIGGERED_EVENT;
   keyId: string;
   velocityPct: number;
   thresholdPct: number;
   windowSize: number;
   currentPrice: string;
   referencePrice: string;
   tradeTxHash: string;
   tradeLedger: number;
   triggeredAt: string;
}

export interface CircuitBreakerResetEvent {
   type: typeof CIRCUIT_BREAKER_RESET_EVENT;
   keyId: string;
   adminWallet: string;
   resetAt: string;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

/** Subscribe to `circuit_breaker_triggered`. Returns an unsubscribe function. */
export function onCircuitBreakerTriggered(
   handler: (event: CircuitBreakerTriggeredEvent) => void
): () => void {
   emitter.on(CIRCUIT_BREAKER_TRIGGERED_EVENT, handler);
   return () => emitter.off(CIRCUIT_BREAKER_TRIGGERED_EVENT, handler);
}

/** Subscribe to `circuit_breaker_reset`. Returns an unsubscribe function. */
export function onCircuitBreakerReset(
   handler: (event: CircuitBreakerResetEvent) => void
): () => void {
   emitter.on(CIRCUIT_BREAKER_RESET_EVENT, handler);
   return () => emitter.off(CIRCUIT_BREAKER_RESET_EVENT, handler);
}

function safeEmit(name: string, payload: unknown): void {
   try {
      emitter.emit(name, payload);
   } catch (error) {
      logger.error(
         { error, event: name },
         'Circuit breaker event listener threw'
      );
   }
}

export function getPriceVelocityConfig(): PriceVelocityConfig {
   return {
      thresholdPct: envConfig.KEY_PRICE_VELOCITY_THRESHOLD_PCT,
      windowSize: envConfig.KEY_PRICE_VELOCITY_WINDOW_SIZE,
   };
}

/**
 * Percentage move from `referencePrice` to `currentPrice`. Returns null when
 * either price is not a finite number or the reference is not positive, since
 * a move from zero has no meaningful percentage.
 */
export function computePriceVelocity(
   currentPrice: number,
   referencePrice: number
): number | null {
   if (!Number.isFinite(currentPrice) || !Number.isFinite(referencePrice)) {
      return null;
   }
   if (referencePrice <= 0) return null;
   return ((currentPrice - referencePrice) / referencePrice) * 100;
}

/**
 * Evaluate the breaker over a key's trade prices, newest first. The velocity
 * is measured against the price exactly `windowSize` trades earlier, so it
 * needs `windowSize + 1` prices; with fewer the breaker does not trip.
 * Triggers when |velocity| is strictly greater than the threshold.
 */
export function evaluatePriceVelocity(
   pricesNewestFirst: readonly string[],
   config: PriceVelocityConfig
): VelocityEvaluation {
   const { thresholdPct, windowSize } = config;
   const base: VelocityEvaluation = {
      velocityPct: null,
      thresholdPct,
      windowSize,
      currentPrice: pricesNewestFirst[0] ?? null,
      referencePrice: null,
      triggered: false,
   };
   if (pricesNewestFirst.length < windowSize + 1) return base;

   const currentPrice = pricesNewestFirst[0];
   const referencePrice = pricesNewestFirst[windowSize];
   const velocityPct = computePriceVelocity(
      Number(currentPrice),
      Number(referencePrice)
   );
   return {
      ...base,
      currentPrice,
      referencePrice,
      velocityPct,
      triggered: velocityPct !== null && Math.abs(velocityPct) > thresholdPct,
   };
}

/**
 * Run the breaker for a key after a trade was indexed. Pauses the key and
 * records the trip when the velocity exceeds the threshold. A key whose
 * breaker is already tripped is left alone, so a burst of trades produces
 * one trip, not one per trade.
 */
export async function checkPriceVelocityAfterTrade(
   db: any,
   trade: { creatorId: string; txHash: string; ledger: number },
   config: PriceVelocityConfig = getPriceVelocityConfig(),
   now: Date = new Date()
): Promise<VelocityEvaluation> {
   const trades: { price: string }[] = await db.trade.findMany({
      where: { creatorId: trade.creatorId },
      orderBy: [{ timestamp: 'desc' }, { ledger: 'desc' }, { id: 'desc' }],
      take: config.windowSize + 1,
      select: { price: true },
   });
   const evaluation = evaluatePriceVelocity(
      trades.map(t => t.price),
      config
   );
   if (!evaluation.triggered || evaluation.velocityPct === null) {
      return evaluation;
   }

   const open = await db.priceVelocityBreakerTrip.findFirst({
      where: {
         keyId: trade.creatorId,
         status: PRICE_VELOCITY_TRIP_STATUS.TRIPPED,
      },
      select: { id: true },
   });
   if (open) return evaluation;

   // Pause first: the pause is what protects holders, the trip row explains it.
   await db.creatorProfile.update({
      where: { id: trade.creatorId },
      data: { tradingPaused: true },
   });
   await db.priceVelocityBreakerTrip.create({
      data: {
         keyId: trade.creatorId,
         velocityPct: evaluation.velocityPct.toFixed(6),
         thresholdPct: evaluation.thresholdPct.toFixed(6),
         windowSize: evaluation.windowSize,
         currentPrice: evaluation.currentPrice!,
         referencePrice: evaluation.referencePrice!,
         tradeTxHash: trade.txHash,
         tradeLedger: trade.ledger,
         status: PRICE_VELOCITY_TRIP_STATUS.TRIPPED,
         triggeredAt: now,
      },
   });

   const event: CircuitBreakerTriggeredEvent = {
      type: CIRCUIT_BREAKER_TRIGGERED_EVENT,
      keyId: trade.creatorId,
      velocityPct: evaluation.velocityPct,
      thresholdPct: evaluation.thresholdPct,
      windowSize: evaluation.windowSize,
      currentPrice: evaluation.currentPrice!,
      referencePrice: evaluation.referencePrice!,
      tradeTxHash: trade.txHash,
      tradeLedger: trade.ledger,
      triggeredAt: now.toISOString(),
   };
   logger.warn(
      event,
      'Key price velocity circuit breaker triggered; trading paused'
   );
   safeEmit(CIRCUIT_BREAKER_TRIGGERED_EVENT, event);
   await emitAuditEvent({
      actor: 'system',
      action: CIRCUIT_BREAKER_TRIGGERED_EVENT,
      target: 'CreatorKey',
      targetId: trade.creatorId,
      metadata: { ...event },
   });

   return evaluation;
}

// ── Admin reset ────────────────────────────────────────────────────────────

export class ResetSignatureError extends Error {
   constructor(
      message: string,
      readonly status: 400 | 401 | 403 = 403
   ) {
      super(message);
      this.name = 'ResetSignatureError';
   }
}

export class BreakerNotTrippedError extends Error {
   constructor(keyId: string) {
      super(`Circuit breaker is not tripped for key ${keyId}`);
      this.name = 'BreakerNotTrippedError';
   }
}

export class BreakerKeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'BreakerKeyNotFoundError';
   }
}

/**
 * The message an admin signs to reset a key's breaker. It binds the key and a
 * timestamp, so a signature cannot be reused for another key or replayed
 * after the tolerance window.
 */
export function buildResetCanonicalMessage(
   keyId: string,
   timestamp: string
): Buffer {
   return createHash('sha256')
      .update(`circuit-breaker-reset:${keyId}:${timestamp}`, 'utf8')
      .digest();
}

export function parseAdminSignerWallets(): string[] {
   const raw = envConfig.ADMIN_MULTISIG_WALLETS;
   if (!raw) return [];
   return raw
      .split(',')
      .map(w => w.trim())
      .filter(w => w.length > 0);
}

/**
 * Verify an admin reset signature. Fails closed: with no admin wallets
 * configured, no signature is accepted.
 *
 * @throws {ResetSignatureError}
 */
export function verifyResetSignature(params: {
   keyId: string;
   adminWallet: string;
   signature: string;
   timestamp: string;
   now?: number;
   adminWallets?: string[];
}): void {
   const admins = params.adminWallets ?? parseAdminSignerWallets();
   if (admins.length === 0) {
      throw new ResetSignatureError('No admin signer wallets are configured');
   }
   if (!admins.includes(params.adminWallet)) {
      throw new ResetSignatureError('Signer is not a configured admin wallet');
   }

   const ts = Number(params.timestamp);
   if (!/^\d+$/.test(params.timestamp) || !Number.isSafeInteger(ts)) {
      throw new ResetSignatureError(
         'Invalid timestamp — must be Unix milliseconds',
         400
      );
   }
   const age = (params.now ?? Date.now()) - ts;
   if (age < 0 || age > RESET_SIGNATURE_TOLERANCE_MS) {
      throw new ResetSignatureError(
         'Signature timestamp is invalid or expired (must be within 5 minutes)',
         401
      );
   }

   const sig = Buffer.from(params.signature, 'base64');
   if (sig.length !== 64) {
      throw new ResetSignatureError(
         'Invalid signature format — Ed25519 signatures must be 64 bytes',
         400
      );
   }

   let valid = false;
   try {
      valid = Keypair.fromPublicKey(params.adminWallet).verify(
         buildResetCanonicalMessage(params.keyId, params.timestamp),
         sig
      );
   } catch {
      valid = false;
   }
   if (!valid) {
      throw new ResetSignatureError('Invalid admin signature');
   }
}

/**
 * Reset a tripped breaker after the admin signature has been verified:
 * closes the open trip and lifts the trading pause.
 */
export async function resetPriceVelocityBreaker(
   db: any,
   keyId: string,
   adminWallet: string,
   now: Date = new Date()
): Promise<{
   keyId: string;
   tradingPaused: false;
   resetTripId: string;
   resetAt: string;
}> {
   const creator = await db.creatorProfile.findUnique({
      where: { id: keyId },
      select: { id: true },
   });
   if (!creator) throw new BreakerKeyNotFoundError(keyId);

   const open = await db.priceVelocityBreakerTrip.findFirst({
      where: { keyId, status: PRICE_VELOCITY_TRIP_STATUS.TRIPPED },
      orderBy: { triggeredAt: 'desc' },
      select: { id: true },
   });
   if (!open) throw new BreakerNotTrippedError(keyId);

   await db.priceVelocityBreakerTrip.updateMany({
      where: { keyId, status: PRICE_VELOCITY_TRIP_STATUS.TRIPPED },
      data: {
         status: PRICE_VELOCITY_TRIP_STATUS.RESET,
         resetByWallet: adminWallet,
         resetAt: now,
      },
   });
   await db.creatorProfile.update({
      where: { id: keyId },
      data: { tradingPaused: false },
   });

   const event: CircuitBreakerResetEvent = {
      type: CIRCUIT_BREAKER_RESET_EVENT,
      keyId,
      adminWallet,
      resetAt: now.toISOString(),
   };
   logger.info(
      event,
      'Key price velocity circuit breaker reset; trading resumed'
   );
   safeEmit(CIRCUIT_BREAKER_RESET_EVENT, event);
   await emitAuditEvent({
      actor: adminWallet,
      action: CIRCUIT_BREAKER_RESET_EVENT,
      target: 'CreatorKey',
      targetId: keyId,
      metadata: { tripId: open.id },
   });

   return {
      keyId,
      tradingPaused: false,
      resetTripId: open.id,
      resetAt: event.resetAt,
   };
}
