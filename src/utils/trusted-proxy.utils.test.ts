// src/utils/trusted-proxy.utils.test.ts

import { normalizeIp, parseTrustedProxies, resolveClientIp } from './trusted-proxy.utils';

describe('normalizeIp', () => {
   it('unwraps IPv4-mapped IPv6, brackets and ports', () => {
      expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
      expect(normalizeIp('[2001:DB8::1]:443')).toBe('2001:db8::1');
      expect(normalizeIp('203.0.113.7:8080')).toBe('203.0.113.7');
      expect(normalizeIp(' 198.51.100.2 ')).toBe('198.51.100.2');
   });

   it('rejects values that are not IP addresses', () => {
      expect(normalizeIp('unknown')).toBeNull();
      expect(normalizeIp('999.1.1.1')).toBeNull();
      expect(normalizeIp('')).toBeNull();
      expect(normalizeIp(undefined)).toBeNull();
   });
});

describe('parseTrustedProxies', () => {
   it('matches exact addresses and IPv4/IPv6 CIDRs', () => {
      const trusted = parseTrustedProxies('10.0.0.0/8, 192.0.2.10, 2001:db8::/32');
      expect(trusted.has('10.20.30.40')).toBe(true);
      expect(trusted.has('192.0.2.10')).toBe(true);
      expect(trusted.has('192.0.2.11')).toBe(false);
      expect(trusted.has('2001:db8:abcd::5')).toBe(true);
      expect(trusted.has('2001:db9::5')).toBe(false);
      expect(trusted.has('::ffff:10.1.1.1')).toBe(true);
   });

   it('trusts nothing when unset', () => {
      const trusted = parseTrustedProxies(undefined);
      expect(trusted.has('127.0.0.1')).toBe(false);
      expect(trusted.has('10.0.0.1')).toBe(false);
   });

   it('throws on invalid entries instead of silently ignoring them', () => {
      expect(() => parseTrustedProxies('10.0.0.0/33')).toThrow(/Invalid TRUSTED_PROXIES/);
      expect(() => parseTrustedProxies('proxy.internal')).toThrow(/Invalid TRUSTED_PROXIES/);
      expect(() => parseTrustedProxies('10.0.0.0/x')).toThrow(/Invalid TRUSTED_PROXIES/);
   });
});

describe('resolveClientIp', () => {
   const trusted = parseTrustedProxies('10.0.0.0/8,2001:db8::/32');

   it('ignores a spoofed X-Forwarded-For from an untrusted peer', () => {
      expect(resolveClientIp('203.0.113.9', '81.2.69.160', trusted)).toBe('203.0.113.9');
   });

   it('ignores X-Forwarded-For entirely when no proxies are configured', () => {
      const none = parseTrustedProxies(undefined);
      expect(resolveClientIp('127.0.0.1', '81.2.69.160', none)).toBe('127.0.0.1');
   });

   it('takes the first untrusted hop walking right to left', () => {
      // client spoofs a leading entry; the real client is the one the edge proxy appended
      expect(resolveClientIp('10.0.0.2', '1.1.1.1, 81.2.69.160, 10.0.0.5', trusted)).toBe(
         '81.2.69.160'
      );
   });

   it('handles IPv6 and IPv4-mapped peers', () => {
      expect(resolveClientIp('2001:db8::1', '2001:218::7', trusted)).toBe('2001:218::7');
      expect(resolveClientIp('::ffff:10.0.0.2', '89.160.20.112', trusted)).toBe('89.160.20.112');
   });

   it('stops at a malformed hop and keeps the last good address', () => {
      expect(resolveClientIp('10.0.0.2', '81.2.69.160, not-an-ip', trusted)).toBe('10.0.0.2');
   });

   it('joins repeated header values and falls back to the peer when absent', () => {
      expect(resolveClientIp('10.0.0.2', ['81.2.69.160', '10.0.0.3'], trusted)).toBe('81.2.69.160');
      expect(resolveClientIp('10.0.0.2', undefined, trusted)).toBe('10.0.0.2');
      expect(resolveClientIp(undefined, '81.2.69.160', trusted)).toBeNull();
   });

   it('returns the leftmost hop when every hop is a trusted proxy', () => {
      expect(resolveClientIp('10.0.0.2', '10.0.0.9, 10.0.0.3', trusted)).toBe('10.0.0.9');
   });
});
