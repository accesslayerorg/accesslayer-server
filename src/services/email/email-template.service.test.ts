// src/services/email/email-template.service.test.ts
// Unit tests for EmailTemplateService and HTML escaping (#1217).

import {
   EmailTemplateService,
   escapeHtml,
} from './email-template.service';

describe('EmailTemplateService', () => {
   const service = new EmailTemplateService();

   describe('escapeHtml', () => {
      it('escapes &, <, >, ", and \' characters', () => {
         const input = `<script>alert("XSS & attack 'now'")</script>`;
         const expected = `&lt;script&gt;alert(&quot;XSS &amp; attack &#039;now&#039;&quot;)&lt;/script&gt;`;
         expect(escapeHtml(input)).toBe(expected);
      });

      it('handles empty strings and null/undefined gracefully', () => {
         expect(escapeHtml('')).toBe('');
         expect(escapeHtml(null as unknown as string)).toBe('');
      });
   });

   describe('renderVerificationEmail', () => {
      it('renders HTML and plain text with escaped content and verification link', () => {
         const wallet = 'GB5WOC7X<script>';
         const email = 'user+test@example.com';
         const verificationUrl = 'https://accesslayer.org/v1/notifications/verify?token=xyz123';

         const { html, text } = service.renderVerificationEmail({
            wallet,
            email,
            verificationUrl,
         });

         // HTML checks
         expect(html).toContain('GB5WOC7X&lt;script&gt;');
         expect(html).not.toContain('<script>');
         expect(html).toContain(email);
         expect(html).toContain(`href="${verificationUrl}"`);

         // Text checks
         expect(text).toContain(wallet);
         expect(text).toContain(email);
         expect(text).toContain(verificationUrl);
         expect(text).toContain('24 hours');
      });
   });

   describe('renderDigestEmail', () => {
      it('renders HTML and text with escaped event data and unsubscribe link', () => {
         const wallet = 'GB5WOC7X';
         const unsubscribeUrl = 'https://accesslayer.org/v1/notifications/unsubscribe?token=abc456';
         const periodStart = new Date('2026-11-20T00:00:00.000Z');
         const periodEnd = new Date('2026-11-21T00:00:00.000Z');

         const events = [
            {
               type: 'KEY_BOUGHT',
               title: 'Key Purchase <VIP>',
               description: 'Bought 5 keys from creator "Star<Lord>" & saved $10',
               timestamp: new Date('2026-11-20T12:00:00.000Z'),
            },
         ];

         const { html, text } = service.renderDigestEmail({
            wallet,
            events,
            periodStart,
            periodEnd,
            unsubscribeUrl,
         });

         // HTML escaping checks
         expect(html).toContain('Key Purchase &lt;VIP&gt;');
         expect(html).toContain('&quot;Star&lt;Lord&gt;&quot; &amp; saved $10');
         expect(html).toContain(`href="${unsubscribeUrl}"`);
         expect(html).toContain('Unsubscribe from email digests');

         // Plain text checks
         expect(text).toContain('Key Purchase <VIP>');
         expect(text).toContain('Bought 5 keys from creator "Star<Lord>" & saved $10');
         expect(text).toContain(unsubscribeUrl);
      });
   });
});
