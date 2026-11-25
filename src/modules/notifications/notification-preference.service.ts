// src/modules/notifications/notification-preference.service.ts
// Business logic for notification preferences, email verification, and unsubscribe (#1217).

import { prisma } from '../../utils/prisma.utils';
import { IMailer } from '../../services/email/mailer.interface';
import { defaultMailer } from '../../services/email/mailer.service';
import { emailTemplateService } from '../../services/email/email-template.service';
import { envConfig } from '../../config';
import {
   createVerificationToken,
   verifyVerificationToken,
   verifyUnsubscribeToken,
   TokenError,
} from './notification-preference.tokens';
import { UpdateNotificationPreferencesInput } from './notification-preference.schemas';
import { NotificationPreference } from '@prisma/client';

export interface ServiceDeps {
   now?: () => Date;
   mailer?: IMailer;
   baseUrl?: string;
}

export class NotificationPreferenceService {
   constructor(private defaultDeps?: ServiceDeps) {}

   setDefaultDeps(deps: ServiceDeps): void {
      this.defaultDeps = { ...this.defaultDeps, ...deps };
   }

   private resolveNow(deps?: ServiceDeps): Date {
      return deps?.now?.() ?? this.defaultDeps?.now?.() ?? new Date();
   }

   private resolveMailer(deps?: ServiceDeps): IMailer {
      return deps?.mailer ?? this.defaultDeps?.mailer ?? defaultMailer;
   }

   private resolveBaseUrl(deps?: ServiceDeps): string {
      return (
         deps?.baseUrl ??
         this.defaultDeps?.baseUrl ??
         `http://localhost:${envConfig.PORT || 3000}`
      );
   }

   /**
    * Retrieves notification preferences for a given wallet address.
    */
   async getPreferences(wallet: string): Promise<NotificationPreference | null> {
      return prisma.notificationPreference.findUnique({
         where: { wallet },
      });
   }

   /**
    * Creates or updates notification preferences for a wallet.
    * If the email address is new or changed, verifiedAt is reset to null
    * and a new verification email is sent with a signed 24-hour token.
    */
   async updatePreferences(
      wallet: string,
      input: UpdateNotificationPreferencesInput,
      deps?: ServiceDeps
   ): Promise<{
      preference: NotificationPreference;
      verificationEmailSent: boolean;
   }> {
      const normalizedEmail = input.email.trim().toLowerCase();
      const existing = await prisma.notificationPreference.findUnique({
         where: { wallet },
      });

      const emailChanged = !existing || existing.email.toLowerCase() !== normalizedEmail;
      const now = this.resolveNow(deps);
      const mailer = this.resolveMailer(deps);
      const baseUrl = this.resolveBaseUrl(deps);

      let verificationEmailSent = false;

      // Upsert preference in database
      const preference = await prisma.notificationPreference.upsert({
         where: { wallet },
         create: {
            wallet,
            email: normalizedEmail,
            frequency: input.frequency,
            events: input.events,
            verifiedAt: null,
            unsubscribedAt: null,
         },
         update: {
            email: normalizedEmail,
            frequency: input.frequency,
            events: input.events,
            ...(emailChanged ? { verifiedAt: null } : {}),
            unsubscribedAt: null,
         },
      });

      // If email is new or changed, send verification email
      if (emailChanged) {
         const token = createVerificationToken(wallet, normalizedEmail, now.getTime());
         const verificationUrl = `${baseUrl}/v1/notifications/verify?token=${token}`;
         const { html, text } = emailTemplateService.renderVerificationEmail({
            wallet,
            email: normalizedEmail,
            verificationUrl,
         });

         verificationEmailSent = await mailer.send({
            to: normalizedEmail,
            subject: 'Verify your email address - Access Layer',
            html,
            text,
         });
      }

      return { preference, verificationEmailSent };
   }

   /**
    * Verifies an email verification token, checks that it matches the current preference,
    * and sets verifiedAt = now().
    */
   async verifyEmail(
      token: string,
      deps?: ServiceDeps
   ): Promise<NotificationPreference> {
      const now = this.resolveNow(deps);
      const { wallet, email } = verifyVerificationToken(token, now.getTime());

      const preference = await prisma.notificationPreference.findUnique({
         where: { wallet },
      });

      if (!preference) {
         throw new TokenError(
            'No notification preferences found for this wallet',
            'MISMATCHED_TARGET'
         );
      }

      if (preference.email.toLowerCase() !== email.toLowerCase()) {
         throw new TokenError(
            'Verification token is for a previous email address and cannot verify the current email',
            'MISMATCHED_TARGET'
         );
      }

      return prisma.notificationPreference.update({
         where: { wallet },
         data: {
            verifiedAt: now,
         },
      });
   }

   /**
    * One-click unsubscribe disabling email digests without requiring login.
    */
   async unsubscribe(
      token: string,
      deps?: ServiceDeps
   ): Promise<NotificationPreference> {
      const now = this.resolveNow(deps);
      const { wallet } = verifyUnsubscribeToken(token);

      const preference = await prisma.notificationPreference.findUnique({
         where: { wallet },
      });

      if (!preference) {
         throw new TokenError(
            'No notification preferences found for this wallet',
            'MISMATCHED_TARGET'
         );
      }

      return prisma.notificationPreference.update({
         where: { wallet },
         data: {
            unsubscribedAt: now,
         },
      });
   }
}

export const notificationPreferenceService = new NotificationPreferenceService();
