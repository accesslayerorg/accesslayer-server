// src/services/email/email-template.service.ts
// Email template rendering service with strict HTML escaping (#1217).

export interface DigestEventItem {
   type: string;
   title?: string;
   description: string;
   timestamp: Date;
   metadata?: Record<string, unknown>;
}

export interface RenderVerificationEmailOptions {
   wallet: string;
   email: string;
   verificationUrl: string;
}

export interface RenderDigestEmailOptions {
   wallet: string;
   events: DigestEventItem[];
   periodStart: Date;
   periodEnd: Date;
   unsubscribeUrl: string;
}

export interface RenderedEmail {
   html: string;
   text: string;
}

/**
 * Escapes characters with special meaning in HTML to prevent XSS / injection attacks.
 */
export function escapeHtml(str: string): string {
   if (!str) return '';
   return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
}

export class EmailTemplateService {
   /**
    * Renders email verification template (HTML and plain text).
    */
   renderVerificationEmail(options: RenderVerificationEmailOptions): RenderedEmail {
      const safeWallet = escapeHtml(options.wallet);
      const safeEmail = escapeHtml(options.email);
      const safeUrl = escapeHtml(options.verificationUrl);

      const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Verify your email - Access Layer</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #111827; background-color: #f9fafb; margin: 0; padding: 24px; }
    .container { max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 8px; border: 1px solid #e5e7eb; padding: 32px; }
    .header { margin-bottom: 24px; }
    .title { font-size: 20px; font-weight: 600; color: #111827; margin: 0 0 8px; }
    .content { font-size: 14px; color: #374151; margin-bottom: 24px; }
    .btn { display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 500; font-size: 14px; }
    .footer { font-size: 12px; color: #6b7280; border-top: 1px solid #e5e7eb; padding-top: 16px; margin-top: 24px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 class="title">Verify your email address</h1>
    </div>
    <div class="content">
      <p>Hello,</p>
      <p>A request was made to set this email address (<strong>${safeEmail}</strong>) for notification digests on Stellar wallet <code>${safeWallet}</code>.</p>
      <p>Please click the button below to confirm your address. This link is valid for 24 hours.</p>
      <p style="margin-top: 24px;">
        <a href="${safeUrl}" class="btn" style="color: #ffffff;">Confirm Email Address</a>
      </p>
      <p style="margin-top: 20px; font-size: 12px; color: #6b7280;">If you did not request this, you can safely ignore this email.</p>
    </div>
    <div class="footer">
      <p>&copy; Access Layer. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`.trim();

      const text = `
Verify your email address - Access Layer

Hello,

A request was made to set this email address (${options.email}) for notification digests on Stellar wallet ${options.wallet}.

Please visit the link below to confirm your address (valid for 24 hours):
${options.verificationUrl}

If you did not request this, you can safely ignore this email.
`.trim();

      return { html, text };
   }

   /**
    * Renders email digest template (HTML and plain text).
    */
   renderDigestEmail(options: RenderDigestEmailOptions): RenderedEmail {
      const safeWallet = escapeHtml(options.wallet);
      const safeUnsubUrl = escapeHtml(options.unsubscribeUrl);
      const periodStartStr = options.periodStart.toUTCString();
      const periodEndStr = options.periodEnd.toUTCString();

      const eventRowsHtml = options.events
         .map(ev => {
            const safeType = escapeHtml(ev.type);
            const safeTitle = escapeHtml(ev.title || ev.type);
            const safeDesc = escapeHtml(ev.description);
            const timeStr = escapeHtml(ev.timestamp.toISOString());
            return `
      <li style="margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid #f3f4f6;">
        <div style="font-weight: 600; font-size: 14px; color: #1f2937;">${safeTitle} <span style="font-size: 12px; font-weight: normal; color: #6b7280;">(${safeType})</span></div>
        <div style="font-size: 13px; color: #4b5563; margin-top: 4px;">${safeDesc}</div>
        <div style="font-size: 11px; color: #9ca3af; margin-top: 2px;">${timeStr}</div>
      </li>`;
         })
         .join('\n');

      const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Your Access Layer Digest</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #111827; background-color: #f9fafb; margin: 0; padding: 24px; }
    .container { max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 8px; border: 1px solid #e5e7eb; padding: 32px; }
    .header { margin-bottom: 20px; }
    .title { font-size: 20px; font-weight: 600; color: #111827; margin: 0 0 6px; }
    .meta { font-size: 12px; color: #6b7280; margin-bottom: 20px; }
    .events-list { list-style: none; padding: 0; margin: 0 0 24px; }
    .footer { font-size: 12px; color: #6b7280; border-top: 1px solid #e5e7eb; padding-top: 16px; margin-top: 24px; }
    .footer a { color: #6b7280; text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 class="title">Access Layer Activity Digest</h1>
      <div class="meta">For wallet <code>${safeWallet}</code> &bull; Period: ${escapeHtml(periodStartStr)} to ${escapeHtml(periodEndStr)}</div>
    </div>
    <ul class="events-list">
${eventRowsHtml}
    </ul>
    <div class="footer">
      <p>You received this digest because you subscribed to activity notifications on Access Layer.</p>
      <p><a href="${safeUnsubUrl}">Unsubscribe from email digests</a> (one click, no login required)</p>
    </div>
  </div>
</body>
</html>
`.trim();

      const eventRowsText = options.events
         .map(ev => {
            const title = ev.title || ev.type;
            return `- [${title} (${ev.type})] ${ev.description} (${ev.timestamp.toISOString()})`;
         })
         .join('\n');

      const text = `
Access Layer Activity Digest
Wallet: ${options.wallet}
Period: ${periodStartStr} to ${periodEndStr}

Events:
${eventRowsText}

To unsubscribe from these email digests at any time:
${options.unsubscribeUrl}
`.trim();

      return { html, text };
   }
}

export const emailTemplateService = new EmailTemplateService();
