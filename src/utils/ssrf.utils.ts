// src/utils/ssrf.utils.ts
// Server-side request forgery (SSRF) guards.
//
// Outbound lookups triggered by user input (for example federation address
// resolution) must never reach loopback, private, link-local, carrier-grade
// NAT, documentation, multicast or reserved address space. The helpers here
// validate the addresses returned by DNS before a caller opens an outbound
// connection.

import dns from 'dns';
import { isIP } from 'net';

export interface ResolvedAddress {
   address: string;
   family: number;
}

/** Minimal shape of the `dns.promises.lookup` call used by the guard. */
export type LookupHostname = (
   hostname: string
) => Promise<ReadonlyArray<ResolvedAddress>>;

/**
 * IPv4 ranges that must never be contacted from a user-triggered lookup.
 * Values are [network address, prefix length].
 */
const BLOCKED_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
   ['0.0.0.0', 8], // "this" network
   ['10.0.0.0', 8], // private
   ['100.64.0.0', 10], // carrier-grade NAT
   ['127.0.0.0', 8], // loopback
   ['169.254.0.0', 16], // link-local (cloud metadata services)
   ['172.16.0.0', 12], // private
   ['192.0.0.0', 24], // IETF protocol assignments
   ['192.0.2.0', 24], // documentation
   ['192.88.99.0', 24], // 6to4 relay anycast
   ['192.168.0.0', 16], // private
   ['198.18.0.0', 15], // benchmarking
   ['198.51.100.0', 24], // documentation
   ['203.0.113.0', 24], // documentation
   ['224.0.0.0', 4], // multicast
   ['240.0.0.0', 4], // reserved, includes 255.255.255.255
];

function parseIpv4(address: string): number[] | null {
   const parts = address.split('.');
   if (parts.length !== 4) return null;

   const bytes: number[] = [];
   for (const part of parts) {
      if (!/^\d{1,3}$/.test(part)) return null;
      const value = Number(part);
      if (value > 255) return null;
      bytes.push(value);
   }
   return bytes;
}

function ipv4ToInt(bytes: readonly number[]): number {
   return (
      ((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3]
   );
}

function isBlockedIpv4(bytes: readonly number[]): boolean {
   const value = ipv4ToInt(bytes);
   return BLOCKED_IPV4_RANGES.some(([network, prefix]) => {
      const networkBytes = parseIpv4(network);
      if (!networkBytes) return false;
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      return (value & mask) === (ipv4ToInt(networkBytes) & mask);
   });
}

/**
 * Parses an IPv6 address (including compressed forms and embedded IPv4
 * dotted-quad notation) into 16 bytes. Returns null when unparseable.
 */
function parseIpv6(address: string): number[] | null {
   const zoneIndex = address.indexOf('%');
   const withoutZone = zoneIndex >= 0 ? address.slice(0, zoneIndex) : address;
   const halves = withoutZone.split('::');
   if (halves.length > 2) return null;

   const parseGroups = (segment: string): number[] | null => {
      if (segment === '') return [];
      const groups: number[] = [];

      for (const part of segment.split(':')) {
         if (part.includes('.')) {
            const ipv4 = parseIpv4(part);
            if (!ipv4) return null;
            groups.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
            continue;
         }
         if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
         groups.push(parseInt(part, 16));
      }

      return groups;
   };

   const head = parseGroups(halves[0]);
   const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
   if (!head || !tail) return null;

   const totalGroups = head.length + tail.length;
   if (halves.length === 1 && totalGroups !== 8) return null;
   if (totalGroups > 8) return null;

   const groups = [
      ...head,
      ...new Array<number>(8 - totalGroups).fill(0),
      ...tail,
   ];

   const bytes: number[] = [];
   for (const group of groups) {
      bytes.push((group >> 8) & 0xff, group & 0xff);
   }
   return bytes;
}

function isBlockedIpv6(bytes: readonly number[]): boolean {
   const isZeroPrefix = (length: number) =>
      bytes.slice(0, length).every(byte => byte === 0);

   // :: (unspecified) and ::1 (loopback)
   if (isZeroPrefix(16)) return true;
   if (isZeroPrefix(15) && bytes[15] === 1) return true;

   // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) — validate
   // the embedded IPv4 address instead of the wrapper.
   const isV4Mapped =
      isZeroPrefix(10) && bytes[10] === 0xff && bytes[11] === 0xff;
   const isV4Compatible = isZeroPrefix(12);
   if (isV4Mapped || isV4Compatible) {
      return isBlockedIpv4(bytes.slice(12));
   }

   // fc00::/7 — unique local addresses
   if ((bytes[0] & 0xfe) === 0xfc) return true;

   // fe80::/10 — link-local
   if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;

   // ff00::/8 — multicast
   if (bytes[0] === 0xff) return true;

   // 2001:db8::/32 — documentation
   if (
      bytes[0] === 0x20 &&
      bytes[1] === 0x01 &&
      bytes[2] === 0x0d &&
      bytes[3] === 0xb8
   ) {
      return true;
   }

   return false;
}

/**
 * Returns true when the address is loopback, private, link-local, multicast
 * or otherwise reserved, or when it cannot be parsed.
 */
export function isBlockedIpAddress(address: string): boolean {
   const family = isIP(address);
   if (family === 4) {
      const bytes = parseIpv4(address);
      return bytes ? isBlockedIpv4(bytes) : true;
   }
   if (family === 6) {
      const bytes = parseIpv6(address);
      return bytes ? isBlockedIpv6(bytes) : true;
   }
   return true;
}

/** Default DNS lookup used by {@link assertPublicHostname}. */
export async function hostnameToLookup(
   hostname: string
): Promise<ReadonlyArray<ResolvedAddress>> {
   const records = await dns.promises.lookup(hostname, {
      all: true,
      verbatim: true,
   });
   return records.map(record => ({
      address: record.address,
      family: record.family,
   }));
}
