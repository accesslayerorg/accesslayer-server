// src/services/email/mailer.service.ts

import nodemailer from 'nodemailer';
import { envConfig } from '../../config';
import { logger } from '../../utils/logger.utils';
import { IMailer, SendEmailOptions } from './mailer.interface';

export class NodemailerMailer implements IMailer {
   private transporter: nodemailer.Transporter | null = null;

   constructor() {
      const { GMAIL_USER, GMAIL_APP_PASSWORD } = envConfig;
      if (GMAIL_USER && GMAIL_APP_PASSWORD) {
         this.transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
               user: GMAIL_USER,
               pass: GMAIL_APP_PASSWORD,
            },
         });
      }
   }

   async send(options: SendEmailOptions): Promise<boolean> {
      const { GMAIL_USER, GMAIL_APP_PASSWORD } = envConfig;

      if (!this.transporter || !GMAIL_USER || !GMAIL_APP_PASSWORD) {
         logger.info(
            { to: options.to, subject: options.subject },
            'Email skipped (SMTP not configured, logging no-op)'
         );
         return true;
      }

      try {
         const mailOptions: nodemailer.SendMailOptions = {
            from: `Access Layer <${GMAIL_USER}>`,
            to: options.to,
            subject: options.subject,
            text: options.text,
            html: options.html,
            headers: options.headers,
         };

         const info = await this.transporter.sendMail(mailOptions);
         logger.info(
            { to: options.to, messageId: info.messageId },
            'Email sent successfully via Nodemailer'
         );
         return true;
      } catch (error) {
         logger.error({ error, to: options.to }, 'Failed to send email via Nodemailer');
         return false;
      }
   }
}

export class LogMailer implements IMailer {
   public sentEmails: SendEmailOptions[] = [];

   async send(options: SendEmailOptions): Promise<boolean> {
      this.sentEmails.push(options);
      logger.info({ to: options.to, subject: options.subject }, '[LogMailer] Email recorded');
      return true;
   }

   clear(): void {
      this.sentEmails = [];
   }
}

export const defaultMailer: IMailer = new NodemailerMailer();
