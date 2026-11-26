// src/utils/trusted-proxy.utils.ts
// Client IP resolution that honors X-Forwarded-For only from configured
// proxies (#1354). Unlike getClientIp in client-ip.utils.ts, nothing is
// trusted by default: an empty TRUSTED_PROXIES list means the connection
// address is always used.

import { BlockList, isIP } from 'net';

/**
 * Normalizes an address for comparison: strips IPv6 brackets and ports,
 * unwraps IPv4-mapped IPv6 (::ffff:1.2.3.4) and lower-cases IPv6.
 * Returns null when the value is not an IP address.
 */
export function normalizeIp(raw: string | undefined | null): string | null {
   if (!raw) return null;
   let ip = raw.trim();
   if (ip.startsWith('[')) {
      const end = ip.indexOf(']');
      if (end > 0) ip = ip.slice(1, end);
   } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) {
      ip = ip.slice(0, ip.lastIndexOf(':'));
   }
   if (ip.toLowerCase().startsWith('::ffff:') && isIP(ip.slice(7)) === 4) {
      ip = ip.slice(7);
   }
   return isIP(ip) ? ip.toLowerCase() : null;
}

export interface TrustedProxies {
   has(ip: string): boolean;
}

/**
 * Parses a comma-separated list of IPs and CIDRs (IPv4 and IPv6).
 *
 * @throws {Error} when an entry is not a valid IP or CIDR, so a typo in
 *   TRUSTED_PROXIES fails loudly instead of silently trusting nothing.
 */
export function parseTrustedProxies(list: string | undefined): TrustedProxies {
   const blockList = new BlockList();
   const entries = (list ?? '')
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean);

   for (const entry of entries) {
      const [address, prefixRaw] = entry.split('/');
      const ip = normalizeIp(address);
      if (!ip) throw new Error(`Invalid TRUSTED_PROXIES entry: ${entry}`);
      const type = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
      if (prefixRaw === undefined) {
         blockList.addAddress(ip, type);
         continue;
      }
      const prefix = Number(prefixRaw);
      const max = type === 'ipv6' ? 128 : 32;
      if (!/^\d+$/.test(prefixRaw) || prefix > max) {
         throw new Error(`Invalid TRUSTED_PROXIES entry: ${entry}`);
      }
      blockList.addSubnet(ip, prefix, type);
   }

   return {
      has(ip: string): boolean {
         const normalized = normalizeIp(ip);
         if (!normalized) return false;
         return blockList.check(normalized, isIP(normalized) === 6 ? 'ipv6' : 'ipv4');
      },
   };
}

/**
 * Resolves the client address from the connection peer and X-Forwarded-For.
 *
 * The header is read only when the peer itself is a trusted proxy. Hops are
 * walked right to left (nearest proxy first), skipping trusted proxies; the
 * first untrusted hop is the client. A malformed hop stops the walk at the
 * last good address, so injected garbage cannot be chosen.
 */
export function resolveClientIp(
   peerAddress: string | undefined,
   forwardedFor: string | string[] | undefined,
   trusted: TrustedProxies
): string | null {
   const peer = normalizeIp(peerAddress);
   if (!peer || !trusted.has(peer) || !forwardedFor) return peer;

   const hops = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor)
      .split(',')
      .map(hop => hop.trim())
      .filter(Boolean);

   let client = peer;
   for (let i = hops.length - 1; i >= 0; i--) {
      const hop = normalizeIp(hops[i]);
      if (!hop) break;
      client = hop;
      if (!trusted.has(hop)) break;
   }
   return client;
}
