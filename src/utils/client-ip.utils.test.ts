import { getClientIp } from './client-ip.utils';
import { Request } from 'express';

function makeReq(
  socketIp: string,
  forwardedFor?: string
): Request {
  return {
    socket: { remoteAddress: socketIp },
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
  } as unknown as Request;
}

describe('getClientIp', () => {
  describe('when socket is a trusted proxy', () => {
    it('returns the first X-Forwarded-For IP', () => {
      const req = makeReq('127.0.0.1', '203.0.113.5, 10.0.0.1');
      expect(getClientIp(req)).toBe('203.0.113.5');
    });

    it('handles a single IP in X-Forwarded-For', () => {
      const req = makeReq('10.0.0.2', '198.51.100.7');
      expect(getClientIp(req)).toBe('198.51.100.7');
    });

    it('trims whitespace from the extracted IP', () => {
      const req = makeReq('192.168.1.1', '  1.2.3.4  , 10.0.0.5');
      expect(getClientIp(req)).toBe('1.2.3.4');
    });

    it('falls back to socket address when X-Forwarded-For is absent', () => {
      const req = makeReq('10.10.10.1');
      expect(getClientIp(req)).toBe('10.10.10.1');
    });

    it('falls back to socket address when X-Forwarded-For is empty string', () => {
      const req = makeReq('172.16.0.1', '');
      expect(getClientIp(req)).toBe('172.16.0.1');
    });

    it('handles array-valued X-Forwarded-For header', () => {
      const req = {
        socket: { remoteAddress: '127.0.0.1' },
        headers: { 'x-forwarded-for': ['9.9.9.9, 10.0.0.1', '8.8.8.8'] },
      } as unknown as Request;
      expect(getClientIp(req)).toBe('9.9.9.9');
    });

    it('accepts private 172.16.x.x as a trusted proxy', () => {
      const req = makeReq('172.16.5.10', '55.55.55.55');
      expect(getClientIp(req)).toBe('55.55.55.55');
    });

    it('accepts IPv6 loopback ::1 as trusted proxy', () => {
      const req = makeReq('::1', '203.0.113.99');
      expect(getClientIp(req)).toBe('203.0.113.99');
    });
  });

  describe('when socket is NOT a trusted proxy', () => {
    it('ignores X-Forwarded-For and returns the socket address', () => {
      const req = makeReq('203.0.113.1', '1.2.3.4');
      expect(getClientIp(req)).toBe('203.0.113.1');
    });

    it('returns socket address even when no forwarded header is present', () => {
      const req = makeReq('8.8.8.8');
      expect(getClientIp(req)).toBe('8.8.8.8');
    });
  });

  describe('custom trusted predicate', () => {
    it('uses the override predicate instead of the default CIDR check', () => {
      const req = makeReq('8.8.8.8', '203.0.113.42');
      // Treat all IPs as trusted via override
      expect(getClientIp(req, () => true)).toBe('203.0.113.42');
    });

    it('rejects all proxies when override always returns false', () => {
      const req = makeReq('127.0.0.1', '203.0.113.42');
      expect(getClientIp(req, () => false)).toBe('127.0.0.1');
    });
  });

  describe('edge cases', () => {
    it('returns undefined when socket address is missing', () => {
      const req = { socket: {}, headers: {} } as unknown as Request;
      expect(getClientIp(req)).toBeUndefined();
    });

    it('returns undefined when socket itself is undefined', () => {
      const req = { headers: {} } as unknown as Request;
      expect(getClientIp(req)).toBeUndefined();
    });
  });
});
