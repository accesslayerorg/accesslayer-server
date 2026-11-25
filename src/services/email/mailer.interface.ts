// src/services/email/mailer.interface.ts

export interface SendEmailOptions {
   to: string;
   subject: string;
   html: string;
   text: string;
   headers?: Record<string, string>;
}

export interface IMailer {
   send(options: SendEmailOptions): Promise<boolean>;
}
