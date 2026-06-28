import { Request } from 'express';

/**
 * Trusted private/loopback CIDR ranges whose forwarded-for addresses are
 * accepted without further validation.  Requests arriving from outside these
 * ranges are not considered trusted proxies, so their X-Forwarded-For header
 * is ignored.
 */
const TRUSTED_PROXY_CIDRS = [
  { prefix: '127.',    bits: 8  },  // 127.0.0.0/8 — loopback
  { prefix: '10.',     bits: 8  },  // 10.0.0.0/8  — private class A
  { prefix: '172.16.', bits: 12 },  // 172.16.0.0/12 — private class B
  { prefix: '192.168.', bits: 16 }, // 192.168.0.0/16 — private class C
  { prefix: '::1',     bits: 128 }, // IPv6 loopback
  { prefix: 'fc00:',   bits: 7  },  // IPv6 unique-local
  { prefix: 'fd',      bits: 8  },  // IPv6 unique-local (fd00::/8)
];

/**
 * Returns true when `ip` originates from a trusted proxy address.
 *
 * Only private/loopback ranges are trusted by default.  Pass a custom
 * `isTrustedProxy` predicate to override (useful in tests or when the
 * deployment uses a known set of proxy IPs).
 */
function isFromTrustedProxy(ip: string): boolean {
  return TRUSTED_PROXY_CIDRS.some(({ prefix }) =>
    ip.startsWith(prefix)
  );
}

/**
 * Extracts the real client IP address from an Express request.
 *
 * Resolution order:
 * 1. If the socket address is a trusted proxy, read the *first* IP from the
 *    `X-Forwarded-For` header (the leftmost value, which is the original
 *    client before any proxies appended their own address).
 * 2. Fall back to the direct socket address (`req.socket.remoteAddress`).
 *
 * The raw body is never read and the function never mutates the request.
 *
 * @param req       - Express Request object.
 * @param trusted   - Optional override predicate for trusted-proxy check.
 *                    Defaults to the private/loopback CIDR check above.
 */
export function getClientIp(
  req: Request,
  trusted: (ip: string) => boolean = isFromTrustedProxy
): string | undefined {
  const socketIp = req.socket?.remoteAddress ?? '';

  if (trusted(socketIp)) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      const firstIp = raw.split(',')[0].trim();
      if (firstIp) return firstIp;
    }
  }

  return socketIp || undefined;
}
