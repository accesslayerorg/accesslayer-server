/**
 * Strips everything after the host from a webhook URL, returning only
 * `scheme://host` (or `scheme://host:port` when a non-standard port is
 * present).  This prevents secrets embedded in paths or query strings from
 * leaking into log output.
 *
 * @example
 * maskWebhookUrl('https://api.example.com/hook?token=secret')
 * // → 'https://api.example.com'
 *
 * maskWebhookUrl('https://hooks.slack.com/services/T123/B456/xyzxyz')
 * // → 'https://hooks.slack.com'
 *
 * maskWebhookUrl('not a url')
 * // → '[invalid url]'
 */
export function maskWebhookUrl(url: string): string {
    try {
        const parsed = new URL(url);
        return parsed.origin;
    } catch {
        return '[invalid url]';
    }
}
