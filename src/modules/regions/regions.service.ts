// src/modules/regions/regions.service.ts
// Jurisdiction restriction rules, request region context and decision
// helpers (#1354).
//
// A feature is restricted for a request when a rule exists for that feature
// in either the detected (IP geolocation) or the declared country. A declared
// country can therefore add restrictions but never lift one.

import { createHmac } from 'crypto';
import type { Request } from 'express';
import type { RegionRule } from '@prisma/client';
import { envConfig } from '../../config';
import { prisma } from '../../utils/prisma.utils';
import { parseTrustedProxies, resolveClientIp, TrustedProxies } from '../../utils/trusted-proxy.utils';
import { geoService, GeoService } from './geo.service';

/** Rules are re-read at most this often, so admin changes apply within a minute. */
export const RULE_CACHE_TTL_MS = 60_000;

export const DECLARED_COUNTRY_HEADER = 'x-declared-country';

export interface Restriction {
   feature: string;
   reason: string;
}

export interface RegionContext {
   detectedCountry: string | null;
   declaredCountry: string | null;
   /** HMAC of the resolved client IP for logs; the raw address is never kept. */
   ipHash: string | null;
}

export class RegionServiceError extends Error {
   constructor(
      readonly statusCode: number,
      readonly code: string,
      message: string
   ) {
      super(message);
      this.name = 'RegionServiceError';
   }
}

let ruleCache: { rules: RegionRule[]; expiresAt: number } | null = null;

export function invalidateRegionRuleCache(): void {
   ruleCache = null;
}

/** Rules used for decisions, cached in memory for RULE_CACHE_TTL_MS. */
export async function getActiveRegionRules(now: number = Date.now()): Promise<RegionRule[]> {
   if (ruleCache && ruleCache.expiresAt > now) return ruleCache.rules;
   const rules = await prisma.regionRule.findMany({
      where: { action: 'BLOCK' },
      orderBy: [{ feature: 'asc' }, { countryCode: 'asc' }],
   });
   ruleCache = { rules, expiresAt: now + RULE_CACHE_TTL_MS };
   return rules;
}

/**
 * Restrictions that apply to any of `countries`, one per feature. Pass
 * `feature` to check a single feature.
 */
export function findRestrictions(
   rules: RegionRule[],
   countries: Array<string | null>,
   feature?: string
): Restriction[] {
   const codes = new Set(countries.filter((c): c is string => !!c).map(c => c.toUpperCase()));
   const byFeature = new Map<string, Restriction>();
   for (const rule of rules) {
      if (feature !== undefined && rule.feature !== feature) continue;
      if (!codes.has(rule.countryCode.toUpperCase()) || byFeature.has(rule.feature)) continue;
      byFeature.set(rule.feature, { feature: rule.feature, reason: rule.reason });
   }
   return [...byFeature.values()];
}

/**
 * Parses the X-Declared-Country header. Absent means null.
 *
 * @throws {RegionServiceError} 400 when present but not an ISO alpha-2 code.
 */
export function parseDeclaredCountry(header: string | string[] | undefined): string | null {
   const value = Array.isArray(header) ? header[0] : header;
   if (value === undefined || value.trim() === '') return null;
   const code = value.trim().toUpperCase();
   if (!/^[A-Z]{2}$/.test(code)) {
      throw new RegionServiceError(
         400,
         'VALIDATION_ERROR',
         'X-Declared-Country must be an ISO 3166-1 alpha-2 country code'
      );
   }
   return code;
}

export function hashIp(ip: string): string {
   const secret = envConfig.IP_HASH_SECRET ?? envConfig.JWT_SECRET;
   return createHmac('sha256', secret).update(ip).digest('hex').slice(0, 32);
}

let trustedProxies: TrustedProxies | null = null;

function getTrustedProxies(): TrustedProxies {
   trustedProxies ??= parseTrustedProxies(envConfig.TRUSTED_PROXIES);
   return trustedProxies;
}

/** Detected and declared country for a request. */
export async function resolveRegionContext(
   req: Request,
   geo: GeoService = geoService,
   proxies: TrustedProxies = getTrustedProxies()
): Promise<RegionContext> {
   const declaredCountry = parseDeclaredCountry(req.headers[DECLARED_COUNTRY_HEADER]);
   const ip = resolveClientIp(req.socket?.remoteAddress, req.headers['x-forwarded-for'], proxies);
   const { country } = await geo.lookup(ip);
   return { detectedCountry: country, declaredCountry, ipHash: ip ? hashIp(ip) : null };
}

// ── Admin CRUD ───────────────────────────────────────────────

export interface RegionRuleInput {
   feature: string;
   countryCode: string;
   reason: string;
}

function mapPrismaError(error: unknown): never {
   const code = (error as { code?: string } | null)?.code;
   if (code === 'P2002') {
      throw new RegionServiceError(409, 'CONFLICT', 'A rule for this feature and country already exists');
   }
   if (code === 'P2025') {
      throw new RegionServiceError(404, 'NOT_FOUND', 'Region rule not found');
   }
   throw error;
}

export async function listRegionRules(): Promise<RegionRule[]> {
   return prisma.regionRule.findMany({
      orderBy: [{ feature: 'asc' }, { countryCode: 'asc' }],
   });
}

export async function createRegionRule(input: RegionRuleInput): Promise<RegionRule> {
   try {
      return await prisma.regionRule.create({
         data: { ...input, countryCode: input.countryCode.toUpperCase(), action: 'BLOCK' },
      });
   } catch (error) {
      return mapPrismaError(error);
   } finally {
      invalidateRegionRuleCache();
   }
}

export async function updateRegionRule(
   id: string,
   input: Partial<RegionRuleInput>
): Promise<RegionRule> {
   try {
      return await prisma.regionRule.update({
         where: { id },
         data: {
            ...input,
            ...(input.countryCode ? { countryCode: input.countryCode.toUpperCase() } : {}),
         },
      });
   } catch (error) {
      return mapPrismaError(error);
   } finally {
      invalidateRegionRuleCache();
   }
}

export async function deleteRegionRule(id: string): Promise<void> {
   try {
      await prisma.regionRule.delete({ where: { id } });
   } catch (error) {
      mapPrismaError(error);
   } finally {
      invalidateRegionRuleCache();
   }
}
