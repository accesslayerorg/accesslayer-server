// src/modules/broadcast/broadcast.worker.ts
// Batch email worker with retry, suppression-list check, signed one-click
// unsubscribe links, and bounce/complaint handling (#1319).

import { prisma } from '../../utils/prisma.utils';
import { SendMail, ISendMailOptions } from '../../utils/mail.utils';
import { envConfig } from '../../config';
import {
   broadcastService,
   signUnsubscribeToken,
} from './broadcast.service';

export type EmailSenderFn = (opts: ISendMailOptions) => Promise<boolean>;

interface WorkerDb {
   broadcast: {
      findMany: (args: any) => Promise<any[]>;
      update: (args: any) => Promise<any>;
   };
   broadcastDelivery: {
      findMany: (args: any) => Promise<any[]>;
      update: (args: any) => Promise<any>;
   };
   broadcastConsent: {
      findFirst: (args: any) => Promise<{ status: string } | null>;
   };
}

function isBounceOrComplaintError(error: unknown): 'BOUNCE' | 'COMPLAINT' | null {
   const msg =
      error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
   if (msg.includes('complaint') || msg.includes('spam')) return 'COMPLAINT';
   if (
      msg.includes('bounce') ||
      msg.includes('550') ||
      msg.includes('554') ||
      msg.includes('mailbox unavailable')
   ) {
      return 'BOUNCE';
   }
   return null;
}

export class BroadcastWorker {
   constructor(
      private readonly sendMail: EmailSenderFn = SendMail,
      private readonly batchSize: number = 50,
      private readonly maxRetries: number = 3
   ) {}

   private get db(): WorkerDb {
      return prisma as unknown as WorkerDb;
   }

   async processDueBroadcasts(now: Date = new Date()): Promise<number> {
      const due = await this.db.broadcast.findMany({
         where: {
            status: 'SCHEDULED',
            scheduledFor: { lte: now },
         },
         orderBy: { scheduledFor: 'asc' },
         take: 10,
      });

      for (const broadcast of due) {
         await this.processBroadcast(broadcast);
      }

      return due.length;
   }

   async processBroadcast(broadcast: {
      id: string;
      creatorId: string;
      subject: string;
      bodyHtml: string;
      bodyText?: string | null;
   }): Promise<{
      sentCount: number;
      failedCount: number;
      bouncedCount: number;
      suppressedCount: number;
   }> {
      await this.db.broadcast.update({
         where: { id: broadcast.id },
         data: { status: 'SENDING' },
      });

      let sentCount = 0;
      let failedCount = 0;
      let bouncedCount = 0;
      let suppressedCount = 0;

      const deliveries = await this.db.broadcastDelivery.findMany({
         where: { broadcastId: broadcast.id, status: 'PENDING' },
         orderBy: { createdAt: 'asc' },
      });

      for (let i = 0; i < deliveries.length; i += this.batchSize) {
         const batch = deliveries.slice(i, i + this.batchSize);

         for (const delivery of batch) {
            const suppressed = await broadcastService.isEmailSuppressed(
               delivery.recipientEmail
            );
            const consent = delivery.consentId
               ? await this.db.broadcastConsent.findFirst({
                    where: { id: delivery.consentId },
                 })
               : null;

            if (suppressed || (consent && consent.status !== 'CONFIRMED')) {
               await this.db.broadcastDelivery.update({
                  where: { id: delivery.id },
                  data: { status: 'SUPPRESSED' },
               });
               suppressedCount++;
               continue;
            }

            const unsubToken = signUnsubscribeToken({
               email: delivery.recipientEmail,
               keyId: broadcast.creatorId,
            });
            const unsubUrl = `${envConfig.FRONTEND_URL}/v1/broadcasts/unsubscribe?token=${unsubToken}`;
            const htmlWithUnsub = `${broadcast.bodyHtml}<hr/><p style="font-size:12px;color:#666">To unsubscribe from these emails, <a href="${unsubUrl}">click here</a>.</p>`;
            const textWithUnsub = `${broadcast.bodyText ?? ''}\n\nUnsubscribe: ${unsubUrl}`;

            let sent = false;
            let attempts = 0;
            let lastError: string | null = null;
            let bounceReason: 'BOUNCE' | 'COMPLAINT' | null = null;

            while (attempts < this.maxRetries && !sent) {
               attempts++;
               try {
                  const ok = await this.sendMail({
                     to: delivery.recipientEmail,
                     subject: broadcast.subject,
                     html: htmlWithUnsub,
                     text: textWithUnsub,
                  });
                  if (ok) {
                     sent = true;
                  } else {
                     lastError = 'Email provider returned false';
                  }
               } catch (err) {
                  lastError = err instanceof Error ? err.message : String(err);
                  bounceReason = isBounceOrComplaintError(err);
                  if (bounceReason) {
                     break;
                  }
               }
            }

            if (sent) {
               await this.db.broadcastDelivery.update({
                  where: { id: delivery.id },
                  data: { status: 'SENT', attempts, sentAt: new Date() },
               });
               sentCount++;
            } else if (bounceReason) {
               await broadcastService.suppressEmail(
                  delivery.recipientEmail,
                  bounceReason
               );
               await this.db.broadcastDelivery.update({
                  where: { id: delivery.id },
                  data: { status: 'BOUNCED', attempts, lastError },
               });
               bouncedCount++;
            } else {
               await this.db.broadcastDelivery.update({
                  where: { id: delivery.id },
                  data: { status: 'FAILED', attempts, lastError },
               });
               failedCount++;
            }
         }
      }

      await this.db.broadcast.update({
         where: { id: broadcast.id },
         data: {
            status: 'COMPLETED',
            sentAt: new Date(),
            sentCount,
            failedCount,
            bouncedCount,
            suppressedCount,
         },
      });

      return { sentCount, failedCount, bouncedCount, suppressedCount };
   }
}

export const broadcastWorker = new BroadcastWorker();
