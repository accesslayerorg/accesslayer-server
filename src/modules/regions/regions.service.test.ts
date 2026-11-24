// src/modules/regions/regions.service.test.ts

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      regionRule: {
         findMany: jest.fn(),
         create: jest.fn(),
         update: jest.fn(),
         delete: jest.fn(),
      },
   },
}));

import type { Request } from 'express';
import { prisma } from '../../utils/prisma.utils';
import { parseTrustedProxies } from '../../utils/trusted-proxy.utils';
import type { GeoService } from './geo.service';
import {
   createRegionRule,
   deleteRegionRule,
   findRestrictions,
   getActiveRegionRules,
   hashIp,
   invalidateRegionRuleCache,
   parseDeclaredCountry,
   RegionServiceError,
   resolveRegionContext,
   RULE_CACHE_TTL_MS,
   updateRegionRule,
} from './regions.service';

const mockRule = prisma.regionRule as unknown as Record<string, jest.Mock>;

function rule(feature: string, countryCode: string, reason = 'REGULATORY_RESTRICTION') {
   const now = new Date('2026-11-24T00:00:00Z');
   return { id: `${feature}-${countryCode}`, feature, countryCode, action: 'BLOCK' as const, reason, createdAt: now, updatedAt: now };
}

describe('findRestrictions', () => {
   const rules = [
      rule('key_trading', 'US', 'SECURITIES_RESTRICTION'),
      rule('key_trading', 'GB'),
      rule('lending', 'GB', 'LENDING_UNAVAILABLE'),
   ];

   it('restricts on the detected country', () => {
      expect(findRestrictions(rules, ['US', null], 'key_trading')).toEqual([
         { feature: 'key_trading', reason: 'SECURITIES_RESTRICTION' },
      ]);
   });

   it('restricts on the declared country even when the detected country is clear', () => {
      expect(findRestrictions(rules, ['SE', 'US'], 'key_trading')).toHaveLength(1);
   });

   it('cannot be lifted by declaring an unrestricted country', () => {
      expect(findRestrictions(rules, ['US', 'SE'], 'key_trading')).toHaveLength(1);
   });

   it('matches country codes case-insensitively', () => {
      expect(findRestrictions(rules, ['us', null], 'key_trading')).toHaveLength(1);
   });

   it('returns nothing without a matching rule or country', () => {
      expect(findRestrictions(rules, ['SE', null], 'key_trading')).toEqual([]);
      expect(findRestrictions(rules, [null, null])).toEqual([]);
      expect(findRestrictions(rules, ['US', null], 'lending')).toEqual([]);
   });

   it('lists each restricted feature once across both countries', () => {
      expect(findRestrictions(rules, ['GB', 'US'])).toEqual([
         { feature: 'key_trading', reason: 'SECURITIES_RESTRICTION' },
         { feature: 'lending', reason: 'LENDING_UNAVAILABLE' },
      ]);
   });
});

describe('parseDeclaredCountry', () => {
   it('accepts and upper-cases alpha-2 codes', () => {
      expect(parseDeclaredCountry('gb')).toBe('GB');
      expect(parseDeclaredCountry([' us '])).toBe('US');
   });

   it('treats an absent or empty header as undeclared', () => {
      expect(parseDeclaredCountry(undefined)).toBeNull();
      expect(parseDeclaredCountry('  ')).toBeNull();
   });

   it('rejects anything that is not an alpha-2 code', () => {
      for (const bad of ['USA', 'U1', '<script>']) {
         expect(() => parseDeclaredCountry(bad)).toThrow(RegionServiceError);
      }
   });
});

describe('rule cache', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      invalidateRegionRuleCache();
      mockRule.findMany.mockResolvedValue([rule('key_trading', 'US')]);
   });

   it('serves rules from memory for 60 seconds, then re-reads', async () => {
      const t0 = 1_000_000;
      await getActiveRegionRules(t0);
      await getActiveRegionRules(t0 + RULE_CACHE_TTL_MS - 1);
      expect(mockRule.findMany).toHaveBeenCalledTimes(1);

      await getActiveRegionRules(t0 + RULE_CACHE_TTL_MS);
      expect(mockRule.findMany).toHaveBeenCalledTimes(2);
   });

   it('is cleared by every admin write, including failed ones', async () => {
      const t0 = 2_000_000;
      await getActiveRegionRules(t0);

      mockRule.create.mockResolvedValue(rule('lending', 'GB'));
      await createRegionRule({ feature: 'lending', countryCode: 'gb', reason: 'LENDING_UNAVAILABLE' });
      await getActiveRegionRules(t0 + 1);
      expect(mockRule.findMany).toHaveBeenCalledTimes(2);

      mockRule.delete.mockRejectedValue({ code: 'P2025' });
      await expect(deleteRegionRule('missing')).rejects.toMatchObject({ statusCode: 404 });
      await getActiveRegionRules(t0 + 2);
      expect(mockRule.findMany).toHaveBeenCalledTimes(3);
   });
});

describe('admin writes', () => {
   beforeEach(() => jest.clearAllMocks());

   it('stores country codes upper-case', async () => {
      mockRule.create.mockResolvedValue(rule('lending', 'GB'));
      await createRegionRule({ feature: 'lending', countryCode: 'gb', reason: 'LENDING_UNAVAILABLE' });
      expect(mockRule.create).toHaveBeenCalledWith({
         data: { feature: 'lending', countryCode: 'GB', reason: 'LENDING_UNAVAILABLE', action: 'BLOCK' },
      });

      mockRule.update.mockResolvedValue(rule('lending', 'FR'));
      await updateRegionRule('r1', { countryCode: 'fr' });
      expect(mockRule.update).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { countryCode: 'FR' } });
   });

   it('maps duplicate rules to 409 and missing rules to 404', async () => {
      mockRule.create.mockRejectedValue({ code: 'P2002' });
      await expect(
         createRegionRule({ feature: 'lending', countryCode: 'GB', reason: 'LENDING_UNAVAILABLE' })
      ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });

      mockRule.update.mockRejectedValue({ code: 'P2025' });
      await expect(updateRegionRule('missing', { reason: 'OTHER_REASON' })).rejects.toMatchObject({
         statusCode: 404,
         code: 'NOT_FOUND',
      });
   });

   it('rethrows unexpected database errors', async () => {
      mockRule.create.mockRejectedValue(new Error('connection reset'));
      await expect(
         createRegionRule({ feature: 'lending', countryCode: 'GB', reason: 'LENDING_UNAVAILABLE' })
      ).rejects.toThrow('connection reset');
   });
});

describe('hashIp', () => {
   it('is a stable keyed hash that never contains the address', () => {
      const hash = hashIp('81.2.69.160');
      expect(hash).toMatch(/^[0-9a-f]{32}$/);
      expect(hashIp('81.2.69.160')).toBe(hash);
      expect(hashIp('81.2.69.161')).not.toBe(hash);
      expect(hash).not.toContain('81.2.69.160');
   });
});

describe('resolveRegionContext', () => {
   const geo = { lookup: jest.fn(async (ip: string | null) => ({ country: ip === '81.2.69.160' ? 'GB' : null })) };
   const proxies = parseTrustedProxies('10.0.0.0/8');

   function req(peer: string, headers: Record<string, string> = {}): Request {
      return { socket: { remoteAddress: peer }, headers } as unknown as Request;
   }

   it('geolocates the forwarded client behind a trusted proxy', async () => {
      const context = await resolveRegionContext(
         req('10.0.0.2', { 'x-forwarded-for': '81.2.69.160', 'x-declared-country': 'us' }),
         geo as unknown as GeoService,
         proxies
      );
      expect(context).toEqual({ detectedCountry: 'GB', declaredCountry: 'US', ipHash: hashIp('81.2.69.160') });
   });

   it('geolocates the connection address when the peer is not trusted', async () => {
      await resolveRegionContext(
         req('203.0.113.9', { 'x-forwarded-for': '81.2.69.160' }),
         geo as unknown as GeoService,
         proxies
      );
      expect(geo.lookup).toHaveBeenLastCalledWith('203.0.113.9');
   });
});
