// src/modules/indexer/flash-loan-guard-indexer.service.ts
// Indexes FlashLoanGuardTriggered contract events (#938).
//
// Responsibilities:
//   - Record one FlashLoanViolation per event (wallet, key id, ledger, tx hash,
//     event index and on-chain timestamp), idempotently across replays.
//   - Raise an alert when a wallet's uncleared violations reach
//     FLASH_LOAN_VIOLATION_THRESHOLD.
//   - Optionally auto-suspend the wallet (FLASH_LOAN_AUTO_SUSPEND_ENABLED),
//     enforced by trade paths through `assertWalletNotSuspended`.
//   - Age violations out of the frequency count after
//     FLASH_LOAN_VIOLATION_COOLDOWN_HOURS via `clearExpiredFlashLoanViolations`,
//     which the cleanup job runs on an interval.

import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { emitAuditEvent } from '../../utils/audit.utils';
import { createAuditEntry } from '../admin/audit-log.service';

/** Domain event type emitted by the contract's flash loan guard. */
export const FLASH_LOAN_GUARD_EVENT_TYPE = 'FLASH_LOAN_GUARD_TRIGGERED';

/** Rows marked as cleared per cleanup pass, to bound the job's write size. */
const CLEANUP_BATCH_SIZE = 5000;

export interface FlashLoanGuardTriggeredEvent extends IndexerChainEvent {
   eventType: 'FLASH_LOAN_GUARD_TRIGGERED';
   /** Wallet that triggered the guard. */
   walletAddress: string;
   /** Key targeted by the attempt, when the contract emits one. */
   keyId?: string | null;
   ledger: number;
   txHash: string;
   eventIndex: number;
   /** On-chain timestamp (ISO string or Date). Defaults to now when absent. */
   occurredAt?: string | Date;
}

export interface ViolationThresholdResult {
   walletAddress: string;
   violationCount: number;
   threshold: number;
   /** True when this evaluation raised a new alert. */
   alerted: boolean;
   /** True while the wallet has an active suspension. */
   suspended: boolean;
}

/**
 * Indexes a batch of FlashLoanGuardTriggered events.
 *
 * Each unique event inserts one violation row and then re-evaluates the
 * wallet's threshold. Duplicate events (same txHash + eventIndex) are skipped
 * so indexer replays cannot inflate a wallet's violation count.
 */
export async function processFlashLoanGuardEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (event.eventType !== FLASH_LOAN_GUARD_EVENT_TYPE) {
         return;
      }

      const typedEvent = event as FlashLoanGuardTriggeredEvent;
      const requiredFields = ['walletAddress', 'ledger', 'txHash', 'eventIndex'];
      for (const field of requiredFields) {
         const value = typedEvent[field as keyof FlashLoanGuardTriggeredEvent];
         if (value === undefined || value === null || value === '') {
            logger.warn(
               {
                  eventId: `${event.txHash}:${event.eventIndex}`,
                  missingField: field,
               },
               'Skipping flash loan guard event due to missing required field'
            );
            return;
         }
      }

      const occurredAt = toEventTimestamp(typedEvent.occurredAt);
      const inserted = await recordFlashLoanViolation(typedEvent, occurredAt);
      if (!inserted) {
         return;
      }

      await evaluateViolationThreshold(typedEvent.walletAddress, occurredAt);
   });
}

/**
 * Inserts a single violation row. Returns false when the event was already
 * recorded (replay) or raced with a concurrent insert of the same event.
 */
async function recordFlashLoanViolation(
   event: FlashLoanGuardTriggeredEvent,
   occurredAt: Date
): Promise<boolean> {
   try {
      await prisma.flashLoanViolation.create({
         data: {
            walletAddress: event.walletAddress,
            keyId: event.keyId ?? null,
            ledger: Number(event.ledger),
            txHash: String(event.txHash),
            eventIndex: Number(event.eventIndex),
            occurredAt,
         },
      });
      return true;
   } catch (error) {
      if (
         error instanceof Prisma.PrismaClientKnownRequestError &&
         error.code === 'P2002'
      ) {
         logger.debug(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               walletAddress: event.walletAddress,
            },
            'Flash loan guard event already indexed; skipping duplicate'
         );
         return false;
      }
      throw error;
   }
}

function toEventTimestamp(value: string | Date | undefined): Date {
   if (value instanceof Date) {
      return value;
   }
   if (typeof value === 'string') {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
         return parsed;
      }
   }
   return new Date();
}

/** Start of the cooldown window: violations before this are no longer counted. */
function getCooldownCutoff(now: Date): Date {
   const cooldownMs =
      envConfig.FLASH_LOAN_VIOLATION_COOLDOWN_HOURS * 60 * 60 * 1000;
   return new Date(now.getTime() - cooldownMs);
}

/** Suspension expiry, or null for an indefinite suspension. */
function buildSuspensionExpiry(now: Date): Date | null {
   const durationHours = envConfig.FLASH_LOAN_SUSPENSION_DURATION_HOURS;
   if (durationHours <= 0) {
      return null;
   }
   return new Date(now.getTime() + durationHours * 60 * 60 * 1000);
}

/**
 * Re-counts a wallet's uncleared violations and applies the threshold side
 * effects: a persisted alert, a structured alert log plus audit entries, and
 * (when FLASH_LOAN_AUTO_SUSPEND_ENABLED is set) an automatic suspension.
 *
 * Each crossing violation alerts exactly once: the alert only fires when the
 * new count exceeds the count recorded for the previous alert.
 */
export async function evaluateViolationThreshold(
   walletAddress: string,
   occurredAt: Date = new Date()
): Promise<ViolationThresholdResult> {
   const threshold = envConfig.FLASH_LOAN_VIOLATION_THRESHOLD;
   const cutoff = getCooldownCutoff(occurredAt);

   const violationCount = await prisma.flashLoanViolation.count({
      where: {
         walletAddress,
         clearedAt: null,
         occurredAt: { gte: cutoff },
      },
   });

   const existing = await prisma.flashLoanGuardStatus.findUnique({
      where: { walletAddress },
   });

   const breached = violationCount >= threshold;
   const shouldAlert =
      breached &&
      violationCount > 0 &&
      violationCount > (existing?.lastAlertedViolationCount ?? 0);
   const shouldSuspend = breached && envConfig.FLASH_LOAN_AUTO_SUSPEND_ENABLED;
   const now = new Date();

   if (!existing && !breached) {
      return {
         walletAddress,
         violationCount,
         threshold,
         alerted: false,
         suspended: false,
      };
   }

   const suspensionActive = isSuspensionActive(
      existing?.suspendedAt ?? null,
      existing?.suspensionExpiresAt ?? null,
      now
   );

   const status = await prisma.flashLoanGuardStatus.upsert({
      where: { walletAddress },
      create: {
         walletAddress,
         violationCount,
         lastViolationAt: occurredAt,
         alertedAt: shouldAlert ? now : null,
         alertCount: shouldAlert ? 1 : 0,
         lastAlertedViolationCount: shouldAlert ? violationCount : 0,
         autoSuspended: shouldSuspend,
         suspendedAt: shouldSuspend ? now : null,
         suspensionExpiresAt: shouldSuspend ? buildSuspensionExpiry(now) : null,
      },
      update: {
         violationCount,
         lastViolationAt: occurredAt,
         ...(shouldAlert
            ? {
                 alertedAt: now,
                 alertCount: { increment: 1 },
                 lastAlertedViolationCount: violationCount,
              }
            : {}),
         ...(shouldSuspend
            ? {
                 autoSuspended: true,
                 ...(suspensionActive ? {} : { suspendedAt: now }),
                 suspensionExpiresAt: suspensionActive
                    ? existing?.suspensionExpiresAt ?? null
                    : buildSuspensionExpiry(now),
                 liftedAt: null,
                 liftedBy: null,
              }
            : {}),
      },
   });

   if (shouldAlert) {
      const alertFields = {
         walletAddress,
         violationCount,
         threshold,
         cooldownHours: envConfig.FLASH_LOAN_VIOLATION_COOLDOWN_HOURS,
         autoSuspended: status.autoSuspended,
      };

      logger.warn(
         { type: 'flash_loan_guard_alert', ...alertFields },
         'Flash loan guard threshold exceeded'
      );

      await emitAuditEvent({
         actor: walletAddress,
         action: 'flash_loan_guard_alert',
         target: 'FlashLoanGuardStatus',
         targetId: walletAddress,
         metadata: alertFields,
      });
      await createAuditEntry({
         actorWallet: walletAddress,
         actionType: 'flash_loan_guard_alert',
         targetId: walletAddress,
         payload: alertFields,
      });
   }

   if (shouldSuspend && !suspensionActive) {
      const suspensionFields = {
         walletAddress,
         violationCount,
         threshold,
         suspendedAt: status.suspendedAt?.toISOString() ?? now.toISOString(),
         suspensionExpiresAt: status.suspensionExpiresAt?.toISOString() ?? null,
      };

      await emitAuditEvent({
         actor: 'system:flash-loan-guard',
         action: 'flash_loan_wallet_suspended',
         target: 'FlashLoanGuardStatus',
         targetId: walletAddress,
         metadata: suspensionFields,
      });
      await createAuditEntry({
         actorWallet: 'system:flash-loan-guard',
         actionType: 'flash_loan_wallet_suspended',
         targetId: walletAddress,
         payload: suspensionFields,
      });
   }

   return {
      walletAddress,
      violationCount,
      threshold,
      alerted: shouldAlert,
      suspended: isSuspensionActive(
         status.suspendedAt,
         status.suspensionExpiresAt,
         now
      ),
   };
}

function isSuspensionActive(
   suspendedAt: Date | null,
   suspensionExpiresAt: Date | null,
   now: Date
): boolean {
   if (!suspendedAt) {
      return false;
   }
   return suspensionExpiresAt === null || suspensionExpiresAt > now;
}

/** Thrown when a suspended wallet attempts to trade. */
export class WalletSuspendedError extends Error {
   constructor(
      public readonly walletAddress: string,
      message = 'Wallet is suspended after repeated flash loan guard violations'
   ) {
      super(message);
      this.name = 'WalletSuspendedError';
   }
}

/**
 * Active suspension for a wallet, or null when the wallet is not suspended
 * (or the suspension has expired).
 */
export async function getActiveWalletSuspension(
   walletAddress: string,
   now: Date = new Date()
): Promise<{ suspendedAt: Date; suspensionExpiresAt: Date | null } | null> {
   const status = await prisma.flashLoanGuardStatus.findUnique({
      where: { walletAddress },
      select: { suspendedAt: true, suspensionExpiresAt: true },
   });

   if (!status?.suspendedAt) {
      return null;
   }
   if (!isSuspensionActive(status.suspendedAt, status.suspensionExpiresAt, now)) {
      return null;
   }

   return {
      suspendedAt: status.suspendedAt,
      suspensionExpiresAt: status.suspensionExpiresAt,
   };
}

export async function isWalletSuspended(
   walletAddress: string,
   now: Date = new Date()
): Promise<boolean> {
   return (await getActiveWalletSuspension(walletAddress, now)) !== null;
}

/**
 * Throws {@link WalletSuspendedError} when the wallet has an active flash loan
 * guard suspension. Called by buy/sell/multi-buy paths before execution.
 */
export async function assertWalletNotSuspended(
   walletAddress: string,
   now: Date = new Date()
): Promise<void> {
   const suspension = await getActiveWalletSuspension(walletAddress, now);
   if (!suspension) {
      return;
   }

   const until = suspension.suspensionExpiresAt
      ? ` until ${suspension.suspensionExpiresAt.toISOString()}`
      : ' until the violation history clears';

   throw new WalletSuspendedError(
      walletAddress,
      `Wallet is suspended after repeated flash loan guard violations${until}`
   );
}

/**
 * Lifts a wallet's suspension (cooldown cleanup or manual admin action) and
 * records the change in the audit trail.
 */
export async function liftWalletSuspension(
   walletAddress: string,
   liftedBy: string,
   now: Date = new Date()
): Promise<void> {
   await prisma.flashLoanGuardStatus.update({
      where: { walletAddress },
      data: {
         autoSuspended: false,
         suspendedAt: null,
         suspensionExpiresAt: null,
         liftedAt: now,
         liftedBy,
      },
   });

   const fields = {
      walletAddress,
      liftedAt: now.toISOString(),
      liftedBy,
   };

   await emitAuditEvent({
      actor: liftedBy,
      action: 'flash_loan_wallet_suspension_lifted',
      target: 'FlashLoanGuardStatus',
      targetId: walletAddress,
      metadata: fields,
   });
   await createAuditEntry({
      actorWallet: liftedBy,
      actionType: 'flash_loan_wallet_suspension_lifted',
      targetId: walletAddress,
      payload: fields,
   });
}

export interface ViolationCleanupResult {
   /** Violations older than this timestamp were cleared. */
   cutoff: Date;
   clearedCount: number;
   /** Wallets whose automatic suspension was lifted by this pass. */
   liftedSuspensions: string[];
}

/**
 * Cooldown cleanup: marks violations older than
 * FLASH_LOAN_VIOLATION_COOLDOWN_HOURS as cleared, refreshes each affected
 * wallet's frequency count and lifts auto-suspensions whose wallet has fallen
 * back below the threshold and whose suspension window has passed.
 */
export async function clearExpiredFlashLoanViolations(
   now: Date = new Date()
): Promise<ViolationCleanupResult> {
   const cutoff = getCooldownCutoff(now);

   const expired = await prisma.flashLoanViolation.findMany({
      where: { clearedAt: null, occurredAt: { lt: cutoff } },
      select: { id: true, walletAddress: true },
      take: CLEANUP_BATCH_SIZE,
   });

   if (expired.length === 0) {
      return { cutoff, clearedCount: 0, liftedSuspensions: [] };
   }

   await prisma.flashLoanViolation.updateMany({
      where: { id: { in: expired.map(row => row.id) } },
      data: { clearedAt: now },
   });

   const wallets = [...new Set(expired.map(row => row.walletAddress))];
   const liftedSuspensions: string[] = [];

   for (const walletAddress of wallets) {
      const violationCount = await prisma.flashLoanViolation.count({
         where: {
            walletAddress,
            clearedAt: null,
            occurredAt: { gte: cutoff },
         },
      });

      const status = await prisma.flashLoanGuardStatus.findUnique({
         where: { walletAddress },
         select: {
            violationCount: true,
            suspendedAt: true,
            suspensionExpiresAt: true,
         },
      });
      if (!status) {
         continue;
      }

      const belowThreshold =
         violationCount < envConfig.FLASH_LOAN_VIOLATION_THRESHOLD;
      const suspensionExpired =
         !status.suspensionExpiresAt || status.suspensionExpiresAt <= now;

      if (status.suspendedAt && belowThreshold && suspensionExpired) {
         await liftWalletSuspension(walletAddress, 'system:cooldown', now);
         liftedSuspensions.push(walletAddress);
         continue;
      }

      await prisma.flashLoanGuardStatus.update({
         where: { walletAddress },
         data: { violationCount },
      });
   }

   logger.info(
      {
         type: 'flash_loan_violation_cleanup',
         cutoff: cutoff.toISOString(),
         clearedCount: expired.length,
         liftedSuspensions,
      },
      'Flash loan violation cooldown cleanup completed'
   );

   return { cutoff, clearedCount: expired.length, liftedSuspensions };
}
