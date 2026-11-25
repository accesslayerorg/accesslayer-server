// src/workers/digest.worker.ts
// Background digest worker scheduled via cron/interval (#1217).

import { randomUUID } from 'crypto';
import { prisma } from '../utils/prisma.utils';
import { logger } from '../utils/logger.utils';
import { envConfig } from '../config';
import { IMailer } from '../services/email/mailer.interface';
import { defaultMailer } from '../services/email/mailer.service';
import {
   DigestEventItem,
   emailTemplateService,
} from '../services/email/email-template.service';
import { createUnsubscribeToken } from '../modules/notifications/notification-preference.tokens';
import { NotificationPreference } from '@prisma/client';

export const DIGEST_DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
export const DIGEST_DEFAULT_CLAIM_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const DIGEST_DEFAULT_BATCH_SIZE = 100;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface DigestWorkerOptions {
   intervalMs?: number;
   now?: () => Date;
   mailer?: IMailer;
   baseUrl?: string;
   batchSize?: number;
   claimTtlMs?: number;
   prisma?: typeof prisma;
}

export interface DigestCycleResult {
   scanned: number;
   claimed: number;
   sent: number;
   skippedEmpty: number;
   failed: number;
}

export class DigestWorker {
   private readonly intervalMs: number;
   private readonly now: () => Date;
   private readonly mailer: IMailer;
   private readonly baseUrl: string;
   private readonly batchSize: number;
   private readonly claimTtlMs: number;
   private readonly db: typeof prisma;
   private timer: NodeJS.Timeout | null = null;
   private cycleInFlight = false;

   constructor(options: DigestWorkerOptions = {}) {
      this.intervalMs = options.intervalMs ?? DIGEST_DEFAULT_INTERVAL_MS;
      this.now = options.now ?? (() => new Date());
      this.mailer = options.mailer ?? defaultMailer;
      this.baseUrl =
         options.baseUrl ??
         (envConfig.APP_BASE_URL || `http://localhost:${envConfig.PORT || 3000}`);
      this.batchSize = options.batchSize ?? DIGEST_DEFAULT_BATCH_SIZE;
      this.claimTtlMs = options.claimTtlMs ?? DIGEST_DEFAULT_CLAIM_TTL_MS;
      this.db = options.prisma ?? prisma;
   }

   start(): void {
      if (this.timer) {
         logger.warn('DigestWorker is already running');
         return;
      }

      void this.runCycle().catch(error => {
         logger.error({ err: error }, 'DigestWorker cycle failed unexpectedly');
      });

      this.timer = setInterval(() => {
         void this.runCycle().catch(error => {
            logger.error({ err: error }, 'DigestWorker cycle failed unexpectedly');
         });
      }, this.intervalMs);

      if (
         typeof (this.timer as unknown as { unref?: () => void }).unref ===
         'function'
      ) {
         (this.timer as unknown as { unref: () => void }).unref();
      }

      logger.info({ intervalMs: this.intervalMs }, 'DigestWorker started');
   }

   stop(): void {
      if (!this.timer) return;
      clearInterval(this.timer);
      this.timer = null;
      logger.info('DigestWorker stopped');
   }

   /**
    * Executes a single evaluation cycle across due subscribers.
    */
   async runCycle(overrideNow?: Date): Promise<DigestCycleResult> {
      if (this.cycleInFlight) {
         logger.warn('DigestWorker cycle skipped: previous cycle still in flight');
         return { scanned: 0, claimed: 0, sent: 0, skippedEmpty: 0, failed: 0 };
      }

      this.cycleInFlight = true;
      const now = overrideNow ?? this.now();

      const result: DigestCycleResult = {
         scanned: 0,
         claimed: 0,
         sent: 0,
         skippedEmpty: 0,
         failed: 0,
      };

      try {
         // Query all candidates: verified, not unsubscribed
         const candidates = await this.db.notificationPreference.findMany({
            where: {
               verifiedAt: { not: null },
               unsubscribedAt: null,
            },
            take: this.batchSize,
         });

         result.scanned = candidates.length;

         for (const pref of candidates) {
            // Check due-ness according to frequency
            if (!this.isDue(pref, now)) {
               continue;
            }

            // Attempt to claim the record atomically to prevent double sends
            const claimToken = randomUUID();
            const claimExpiresAt = new Date(now.getTime() + this.claimTtlMs);

            const claimed = await this.tryClaimPreference(
               pref.id,
               claimToken,
               claimExpiresAt,
               now
            );

            if (!claimed) {
               // Record was claimed by a concurrent worker
               continue;
            }

            result.claimed += 1;

            try {
               const outcome = await this.processSubscriber(pref, now);
               if (outcome === 'SENT') {
                  result.sent += 1;
               } else if (outcome === 'SKIPPED_EMPTY') {
                  result.skippedEmpty += 1;
               } else {
                  result.failed += 1;
               }
            } catch (error) {
               result.failed += 1;
               logger.error(
                  { err: error, wallet: pref.wallet, email: pref.email },
                  'Failed to process digest for subscriber'
               );
               // Release claim lock so it can be retried later
               await this.releaseClaim(pref.id);
            }
         }

         logger.info(result, 'DigestWorker cycle completed');
         return result;
      } finally {
         this.cycleInFlight = false;
      }
   }

   /**
    * Evaluates whether a preference is due for a digest run.
    */
   isDue(pref: NotificationPreference, now: Date): boolean {
      if (!pref.verifiedAt || pref.unsubscribedAt) return false;

      const intervalMs = pref.frequency === 'weekly' ? WEEK_MS : DAY_MS;
      if (!pref.lastDigestAt) {
         // First run is immediately due
         return true;
      }

      const elapsed = now.getTime() - pref.lastDigestAt.getTime();
      return elapsed >= intervalMs;
   }

   /**
    * Atomically claims a row to avoid double sends across concurrent workers.
    */
   private async tryClaimPreference(
      id: string,
      claimToken: string,
      claimExpiresAt: Date,
      now: Date
   ): Promise<boolean> {
      try {
         const updateResult = await this.db.notificationPreference.updateMany({
            where: {
               id,
               OR: [
                  { claimExpiresAt: null },
                  { claimExpiresAt: { lt: now } },
               ],
            },
            data: {
               claimToken,
               claimExpiresAt,
            },
         });
         return updateResult.count > 0;
      } catch {
         return false;
      }
   }

   private async releaseClaim(id: string): Promise<void> {
      try {
         await this.db.notificationPreference.update({
            where: { id },
            data: {
               claimToken: null,
               claimExpiresAt: null,
            },
         });
      } catch (err) {
         logger.warn({ err, id }, 'Could not release digest claim lock');
      }
   }

   /**
    * Gathers events for a subscriber, formats email, and sends if non-empty.
    */
   private async processSubscriber(
      pref: NotificationPreference,
      now: Date
   ): Promise<'SENT' | 'SKIPPED_EMPTY' | 'FAILED'> {
      // Determine time window: since lastDigestAt or default fallback on first run
      const intervalMs = pref.frequency === 'weekly' ? WEEK_MS : DAY_MS;
      const periodStart = pref.lastDigestAt ?? new Date(now.getTime() - intervalMs);

      const events = await this.gatherEventsForSubscriber(
         pref.wallet,
         pref.events,
         periodStart,
         now
      );

      // Acceptance criterion: No email is sent when there are no events in the period
      if (events.length === 0) {
         await this.releaseClaim(pref.id);
         return 'SKIPPED_EMPTY';
      }

      // Render email with one-click unsubscribe link
      const unsubToken = createUnsubscribeToken(pref.wallet);
      const unsubUrl = `${this.baseUrl}/v1/notifications/unsubscribe?token=${unsubToken}`;

      const { html, text } = emailTemplateService.renderDigestEmail({
         wallet: pref.wallet,
         events,
         periodStart,
         periodEnd: now,
         unsubscribeUrl: unsubUrl,
      });

      const sent = await this.mailer.send({
         to: pref.email,
         subject: 'Your Access Layer Activity Digest',
         html,
         text,
         headers: {
            'List-Unsubscribe': `<${unsubUrl}>`,
         },
      });

      if (!sent) {
         await this.releaseClaim(pref.id);
         return 'FAILED';
      }

      // Update lastDigestAt strictly upon successful send
      await this.db.notificationPreference.update({
         where: { id: pref.id },
         data: {
            lastDigestAt: now,
            claimToken: null,
            claimExpiresAt: null,
         },
      });

      return 'SENT';
   }

   /**
    * Collects events matching the subscriber's selected event types.
    */
   async gatherEventsForSubscriber(
      wallet: string,
      selectedTypes: string[],
      since: Date,
      until: Date
   ): Promise<DigestEventItem[]> {
      const selectedSet = new Set(selectedTypes);
      const items: DigestEventItem[] = [];

      // 1. Trades (KEY_BOUGHT)
      if (selectedSet.has('KEY_BOUGHT') || selectedSet.has('trade_completed')) {
         const trades = await this.db.trade.findMany({
            where: {
               buyer: wallet,
               timestamp: { gte: since, lte: until },
            },
            orderBy: { timestamp: 'desc' },
         });

         for (const trade of trades) {
            items.push({
               type: 'KEY_BOUGHT',
               title: 'Key Purchase',
               description: `Purchased ${trade.quantity} key(s) of creator ${trade.creatorId} at ${trade.price} ${trade.paymentAsset}`,
               timestamp: trade.timestamp,
               metadata: {
                  tradeId: trade.id,
                  creatorId: trade.creatorId,
                  price: trade.price,
                  quantity: trade.quantity,
               },
            });
         }
      }

      // 2. Limit Orders
      if (selectedSet.has('LIMIT_ORDER_CREATED') || selectedSet.has('orders')) {
         const orders = await this.db.limitOrder.findMany({
            where: {
               wallet,
               createdAt: { gte: since, lte: until },
            },
            orderBy: { createdAt: 'desc' },
         });

         for (const order of orders) {
            items.push({
               type: 'LIMIT_ORDER_CREATED',
               title: 'Limit Order Placed',
               description: `Placed ${order.side} limit order for ${order.quantity} of ${order.keyId} at ${order.targetPrice} XLM`,
               timestamp: order.createdAt,
               metadata: {
                  orderId: order.id,
                  keyId: order.keyId,
                  side: order.side,
               },
            });
         }
      }

      // 3. Activity log
      const activities = await this.db.activity.findMany({
         where: {
            OR: [{ actor: wallet }, { target: wallet }],
            createdAt: { gte: since, lte: until },
         },
         orderBy: { createdAt: 'desc' },
      });

      for (const act of activities) {
         if (selectedSet.has(act.type)) {
            items.push({
               type: act.type,
               title: act.type.replace(/_/g, ' '),
               description: `Activity ${act.type} recorded for actor ${act.actor}`,
               timestamp: act.createdAt,
               metadata: typeof act.payload === 'object' && act.payload !== null ? (act.payload as Record<string, unknown>) : {},
            });
         }
      }

      // Sort chronological descending
      return items.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
   }
}

export let digestWorker: DigestWorker | null = null;

export function startDigestWorker(options?: DigestWorkerOptions): DigestWorker {
   if (!digestWorker) {
      digestWorker = new DigestWorker(options);
      digestWorker.start();
   }
   return digestWorker;
}

export function stopDigestWorker(): void {
   if (digestWorker) {
      digestWorker.stop();
      digestWorker = null;
   }
}
