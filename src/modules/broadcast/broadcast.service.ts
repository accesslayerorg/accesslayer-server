// src/modules/broadcast/broadcast.service.ts
// Consented creator email broadcast pipeline (#1319).

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';
import { SendMail } from '../../utils/mail.utils';

export const MAX_BROADCASTS_PER_MONTH = 4;
export const MAX_RECIPIENTS_PER_BROADCAST = 100_000;
const CONFIRM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export class BroadcastMonthlyLimitError extends Error {
   constructor() {
      super(
         `Monthly broadcast limit of ${MAX_BROADCASTS_PER_MONTH} per key exceeded`
      );
      this.name = 'BroadcastMonthlyLimitError';
   }
}

export class BroadcastRecipientLimitError extends Error {
   constructor(count: number) {
      super(
         `Recipient count ${count} exceeds maximum of ${MAX_RECIPIENTS_PER_BROADCAST}`
      );
      this.name = 'BroadcastRecipientLimitError';
   }
}

export class InvalidConsentTokenError extends Error {
   constructor(message = 'Invalid or expired confirmation token') {
      super(message);
      this.name = 'InvalidConsentTokenError';
   }
}

export class InvalidUnsubscribeTokenError extends Error {
   constructor(message = 'Invalid unsubscribe token') {
      super(message);
      this.name = 'InvalidUnsubscribeTokenError';
   }
}

interface BroadcastDb {
   broadcastConsent: {
      findFirst: (args: any) => Promise<any>;
      findMany: (args: any) => Promise<any[]>;
      upsert: (args: any) => Promise<any>;
      update: (args: any) => Promise<any>;
      updateMany: (args: any) => Promise<{ count: number }>;
   };
   emailSuppression: {
      findUnique: (args: any) => Promise<{ email: string; reason: string } | null>;
      findMany: (args: any) => Promise<Array<{ email: string; reason: string }>>;
      upsert: (args: any) => Promise<any>;
   };
   keyOwnership: {
      findMany: (args: any) => Promise<
         Array<{ ownerAddress: string; balance: unknown }>
      >;
   };
   broadcast: {
      count: (args: any) => Promise<number>;
      create: (args: any) => Promise<any>;
      findMany: (args: any) => Promise<any[]>;
      update: (args: any) => Promise<any>;
   };
   broadcastDelivery: {
      createMany: (args: any) => Promise<{ count: number }>;
   };
   creatorProfile: {
      findUnique: (args: any) => Promise<{
         id: string;
         handle: string;
         displayName: string;
      } | null>;
   };
}

function hashToken(token: string): string {
   return createHash('sha256').update(token).digest('hex');
}

function getSigningSecret(): string {
   return envConfig.JWT_SECRET || 'accesslayer-broadcast-secret';
}

export function getCalendarMonthBoundsUtc(date: Date = new Date()): {
   start: Date;
   end: Date;
} {
   const start = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0)
   );
   const end = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0)
   );
   return { start, end };
}

export function signUnsubscribeToken(payload: {
   email: string;
   keyId?: string;
}): string {
   const data = Buffer.from(
      JSON.stringify({
         email: payload.email.trim().toLowerCase(),
         keyId: payload.keyId ?? null,
      })
   ).toString('base64url');
   const sig = createHmac('sha256', getSigningSecret())
      .update(data)
      .digest('base64url');
   return `${data}.${sig}`;
}

export function verifyUnsubscribeToken(token: string): {
   email: string;
   keyId: string | null;
} {
   const parts = token.split('.');
   if (parts.length !== 2) {
      throw new InvalidUnsubscribeTokenError();
   }
   const [data, sig] = parts;
   const expected = createHmac('sha256', getSigningSecret())
      .update(data)
      .digest('base64url');

   const a = Buffer.from(sig);
   const b = Buffer.from(expected);
   if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new InvalidUnsubscribeTokenError();
   }

   try {
      const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
      if (!parsed.email || typeof parsed.email !== 'string') {
         throw new InvalidUnsubscribeTokenError();
      }
      return {
         email: parsed.email.toLowerCase(),
         keyId: typeof parsed.keyId === 'string' ? parsed.keyId : null,
      };
   } catch {
      throw new InvalidUnsubscribeTokenError();
   }
}

export class BroadcastService {
   private get db(): BroadcastDb {
      return prisma as unknown as BroadcastDb;
   }

   async setConsentPreference(params: {
      userId: string;
      wallet: string;
      keyId: string;
      email: string;
      optIn: boolean;
      now?: Date;
   }): Promise<{ status: string; confirmationRequired: boolean }> {
      const now = params.now ?? new Date();
      const normalizedEmail = params.email.trim().toLowerCase();

      if (!params.optIn) {
         const record = await this.db.broadcastConsent.upsert({
            where: {
               userId_keyId: { userId: params.userId, keyId: params.keyId },
            },
            create: {
               userId: params.userId,
               wallet: params.wallet,
               keyId: params.keyId,
               email: normalizedEmail,
               status: 'OPTED_OUT',
               optedOutAt: now,
            },
            update: {
               email: normalizedEmail,
               wallet: params.wallet,
               status: 'OPTED_OUT',
               optedOutAt: now,
               confirmTokenHash: null,
               confirmExpiresAt: null,
            },
         });
         return { status: record.status, confirmationRequired: false };
      }

      const rawToken = randomBytes(24).toString('hex');
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(now.getTime() + CONFIRM_TOKEN_TTL_MS);

      const record = await this.db.broadcastConsent.upsert({
         where: {
            userId_keyId: { userId: params.userId, keyId: params.keyId },
         },
         create: {
            userId: params.userId,
            wallet: params.wallet,
            keyId: params.keyId,
            email: normalizedEmail,
            status: 'PENDING',
            confirmTokenHash: tokenHash,
            confirmExpiresAt: expiresAt,
         },
         update: {
            email: normalizedEmail,
            wallet: params.wallet,
            status: 'PENDING',
            confirmTokenHash: tokenHash,
            confirmExpiresAt: expiresAt,
            optedOutAt: null,
         },
      });

      const confirmUrl = `${envConfig.FRONTEND_URL}/broadcasts/confirm?token=${rawToken}`;
      await SendMail({
         to: normalizedEmail,
         subject: 'Confirm your creator email subscription',
         text: `Confirm your email subscription for key ${params.keyId}: ${confirmUrl}`,
         html: `<p>Please confirm your email subscription by clicking <a href="${confirmUrl}">confirm subscription</a>.</p>`,
      });

      return { status: record.status, confirmationRequired: true };
   }

   async confirmConsent(token: string, now: Date = new Date()) {
      const tokenHash = hashToken(token);
      const record = await this.db.broadcastConsent.findFirst({
         where: {
            confirmTokenHash: tokenHash,
         },
      });

      if (
         !record ||
         !record.confirmExpiresAt ||
         new Date(record.confirmExpiresAt).getTime() < now.getTime()
      ) {
         throw new InvalidConsentTokenError();
      }

      return this.db.broadcastConsent.update({
         where: { id: record.id },
         data: {
            status: 'CONFIRMED',
            confirmedAt: now,
            confirmTokenHash: null,
            confirmExpiresAt: null,
         },
      });
   }

   async isEmailSuppressed(email: string): Promise<boolean> {
      const normalized = email.trim().toLowerCase();
      const row = await this.db.emailSuppression.findUnique({
         where: { email: normalized },
      });
      return Boolean(row);
   }

   async suppressEmail(
      email: string,
      reason: 'UNSUBSCRIBE' | 'BOUNCE' | 'COMPLAINT'
   ): Promise<void> {
      const normalized = email.trim().toLowerCase();
      await this.db.emailSuppression.upsert({
         where: { email: normalized },
         create: { email: normalized, reason },
         update: { reason },
      });
   }

   async unsubscribeByToken(
      token: string,
      now: Date = new Date()
   ): Promise<{ email: string; keyId: string | null }> {
      const parsed = verifyUnsubscribeToken(token);
      await this.suppressEmail(parsed.email, 'UNSUBSCRIBE');
      await this.db.broadcastConsent.updateMany({
         where: {
            email: parsed.email,
            ...(parsed.keyId ? { keyId: parsed.keyId } : {}),
         },
         data: {
            status: 'OPTED_OUT',
            optedOutAt: now,
         },
      });
      return parsed;
   }

   async getEligibleAudience(
      keyId: string,
      minBalance: number = 0
   ): Promise<{
      count: number;
      recipients: Array<{ consentId: string; email: string; wallet: string }>;
   }> {
      const confirmedConsents = await this.db.broadcastConsent.findMany({
         where: {
            keyId,
            status: 'CONFIRMED',
         },
      });

      if (confirmedConsents.length === 0) {
         return { count: 0, recipients: [] };
      }

      const emails = Array.from(
         new Set(confirmedConsents.map((c) => String(c.email).toLowerCase()))
      );
      const suppressions = await this.db.emailSuppression.findMany({
         where: { email: { in: emails } },
      });
      const suppressedSet = new Set(
         suppressions.map((s) => s.email.toLowerCase())
      );

      let eligibleWallets: Set<string> | null = null;
      if (minBalance > 0) {
         const holdings = await this.db.keyOwnership.findMany({
            where: {
               creatorId: keyId,
               balance: { gte: minBalance },
            },
            select: { ownerAddress: true, balance: true },
         });
         eligibleWallets = new Set(holdings.map((h) => h.ownerAddress));
      }

      const recipients: Array<{
         consentId: string;
         email: string;
         wallet: string;
      }> = [];
      const seenEmails = new Set<string>();

      for (const consent of confirmedConsents) {
         const email = String(consent.email).toLowerCase();
         if (suppressedSet.has(email) || seenEmails.has(email)) continue;
         if (eligibleWallets && !eligibleWallets.has(consent.wallet)) continue;
         seenEmails.add(email);
         recipients.push({
            consentId: consent.id,
            email,
            wallet: consent.wallet,
         });
      }

      return { count: recipients.length, recipients };
   }

   async previewAudience(keyId: string, minBalance: number = 0) {
      const { count } = await this.getEligibleAudience(keyId, minBalance);
      return { keyId, minBalance, count };
   }

   async createBroadcast(params: {
      creatorId: string;
      subject: string;
      bodyHtml: string;
      bodyText?: string;
      minBalance?: number;
      scheduledFor?: Date;
      now?: Date;
   }) {
      const now = params.now ?? new Date();
      const { start, end } = getCalendarMonthBoundsUtc(now);

      const monthlyCount = await this.db.broadcast.count({
         where: {
            creatorId: params.creatorId,
            createdAt: { gte: start, lt: end },
         },
      });

      if (monthlyCount >= MAX_BROADCASTS_PER_MONTH) {
         throw new BroadcastMonthlyLimitError();
      }

      const minBalance = params.minBalance ?? 0;
      const { count, recipients } = await this.getEligibleAudience(
         params.creatorId,
         minBalance
      );

      if (count > MAX_RECIPIENTS_PER_BROADCAST) {
         throw new BroadcastRecipientLimitError(count);
      }

      const broadcast = await this.db.broadcast.create({
         data: {
            creatorId: params.creatorId,
            subject: params.subject,
            bodyHtml: params.bodyHtml,
            bodyText: params.bodyText ?? null,
            minBalance,
            status: 'SCHEDULED',
            scheduledFor: params.scheduledFor ?? now,
            recipientCount: count,
         },
      });

      if (recipients.length > 0) {
         await this.db.broadcastDelivery.createMany({
            data: recipients.map((r) => ({
               broadcastId: broadcast.id,
               consentId: r.consentId,
               recipientEmail: r.email,
               wallet: r.wallet,
               status: 'PENDING',
            })),
            skipDuplicates: true,
         });
      }

      return broadcast;
   }

   async getCreatorBroadcastsByHandle(handle: string) {
      const creator = await this.db.creatorProfile.findUnique({
         where: { handle },
         select: { id: true, handle: true, displayName: true },
      });

      if (!creator) {
         return null;
      }

      const broadcasts = await this.db.broadcast.findMany({
         where: { creatorId: creator.id },
         orderBy: { createdAt: 'desc' },
      });

      return {
         creator,
         broadcasts: broadcasts.map((b) => ({
            id: b.id,
            subject: b.subject,
            status: b.status,
            scheduledFor: b.scheduledFor,
            sentAt: b.sentAt,
            createdAt: b.createdAt,
            stats: {
               recipientCount: b.recipientCount,
               sentCount: b.sentCount,
               failedCount: b.failedCount,
               bouncedCount: b.bouncedCount,
               suppressedCount: b.suppressedCount,
            },
         })),
      };
   }
}

export const broadcastService = new BroadcastService();
