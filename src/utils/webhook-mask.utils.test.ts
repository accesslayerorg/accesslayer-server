import { maskWebhookUrl } from './webhook-mask.utils';

describe('maskWebhookUrl', () => {
    it('strips query string containing a secret', () => {
        expect(maskWebhookUrl('https://api.example.com/hook?token=secret')).toBe('https://api.example.com');
    });

    it('strips path segments', () => {
        expect(maskWebhookUrl('https://hooks.slack.com/services/T123/B456/xyzxyz')).toBe('https://hooks.slack.com');
    });

    it('returns the URL as-is when there is no path or query string', () => {
        expect(maskWebhookUrl('http://localhost:3000')).toBe('http://localhost:3000');
    });

    it('returns [invalid url] for a non-URL string', () => {
        expect(maskWebhookUrl('not a url')).toBe('[invalid url]');
    });

    it('returns [invalid url] for an empty string', () => {
        expect(maskWebhookUrl('')).toBe('[invalid url]');
    });

    it('strips path and preserves non-standard port', () => {
        expect(maskWebhookUrl('https://internal.corp:8443/webhooks/receiver?auth=abc')).toBe('https://internal.corp:8443');
    });

    it('strips fragment identifiers', () => {
        expect(maskWebhookUrl('https://example.com/path#section')).toBe('https://example.com');
    });
});
