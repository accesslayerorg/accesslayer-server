// src/services/federation.service.ts
// Stellar federation resolution proxy (#1222).
//
// Browsers cannot call federation servers directly because most of them do
// not send CORS headers. This service performs the lookup server-side:
//
// - The address (`name*domain`) is validated before any network work.
// - Every A/AAAA record behind the domain is checked against
//   {@link isBlockedIpAddress} so a lookup can never reach private, loopback
//   or link-local address space (SSRF protection).
// - Successful resolutions are cached in Redis under `fed:<address>` for 10
//   minutes; not-found results are cached for 1 minute to avoid hammering the
//   federation server.
// - The whole lookup, including the stellar.toml fetch, is bounded by a
//   3 second timeout and maps to HTTP 504.

import { StrKey } from '@stellar/stellar-base';
import {
   hostnameToLookup,
   isBlockedIpAddress,
   type LookupHostname,
} from '../utils/ssrf.utils';
import { cacheGetJson, cacheSetJson } from '../utils/redis.utils';
import { logger } from '../utils/logger.utils';

/** Outbound timeout for a complete federation lookup (stellar.toml + query). */
export const FEDERATION_TIMEOUT_MS = 3_000;

/** TTL for a successful resolution. */
export const FEDERATION_CACHE_TTL_SECONDS = 10 * 60;

/** TTL for a negative (not found) result. */
export const FEDERATION_NEGATIVE_CACHE_TTL_SECONDS = 60;

/** Maximum accepted address length. */
export const FEDERATION_ADDRESS_MAX_LENGTH = 320;

const NAME_PATTERN = /^[^\s*@]+$/;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const DOMAIN_TLD_PATTERN = /^[a-z]{2,63}$/i;

export interface ParsedFederationAddress {
   /** Name portion, lower-cased (SEP-0002 addresses are case-insensitive). */
   name: string;
   /** Domain portion, lower-cased. */
   domain: string;
   /** Canonical `name*domain` used for cache keys and the outbound lookup. */
   address: string;
}

export interface FederationResolution {
   accountId: string;
   memo?: string;
   memoType?: string;
}

export interface FederationServiceDependencies {
   /** Performs the actual federation lookup. Defaults to the Stellar SDK. */
   resolveFederation?: (address: string) => Promise<unknown>;
   /** DNS resolution used for the SSRF check. */
   lookupHostname?: LookupHostname;
   getCache?: <T>(key: string) => Promise<T | null>;
   setCache?: (
      key: string,
      value: unknown,
      ttlSeconds: number
   ) => Promise<void>;
   timeoutMs?: number;
}

/** Raised when the requested address is not a valid `name*domain` address. */
export class FederationAddressError extends Error {
   constructor(address: string) {
      super(
         `Invalid federation address "${address}". Expected name*domain with a valid domain.`
      );
      this.name = 'FederationAddressError';
   }
}

/** Raised when the domain resolves to blocked (non-public) address space. */
export class FederationBlockedAddressError extends Error {
   constructor(message: string) {
      super(message);
      this.name = 'FederationBlockedAddressError';
   }
}

/** Raised when the federation server has no record for the address. */
export class FederationNotFoundError extends Error {
   constructor(address: string) {
      super(`No federation record found for ${address}`);
      this.name = 'FederationNotFoundError';
   }
}

/** Raised when the federation lookup exceeds its timeout. */
export class FederationTimeoutError extends Error {
   constructor(timeoutMs: number) {
      super(`Federation lookup timed out after ${timeoutMs}ms`);
      this.name = 'FederationTimeoutError';
   }
}

/** Raised when the federation server fails unexpectedly. */
export class FederationUpstreamError extends Error {
   constructor(message: string) {
      super(message);
      this.name = 'FederationUpstreamError';
   }
}

/** Redis key for a successful resolution. */
export function federationCacheKey(address: string): string {
   return `fed:${address.toLowerCase()}`;
}

/** Redis key for a cached not-found result. */
export function federationNegativeCacheKey(address: string): string {
   return `fed:${address.toLowerCase()}:notfound`;
}

/**
 * Validates and normalizes a federation address.
 *
 * Requires exactly one `*`, a non-empty name without whitespace or `@`, and a
 * domain with at least two labels, each a valid hostname label, ending in an
 * alphabetic TLD. IP literals and single-label hosts such as `localhost` are
 * rejected. Returns null when the address is invalid.
 */
export function parseFederationAddress(
   address: string
): ParsedFederationAddress | null {
   if (
      typeof address !== 'string' ||
      address.length === 0 ||
      address.length > FEDERATION_ADDRESS_MAX_LENGTH
   ) {
      return null;
   }

   const trimmed = address.trim();
   const parts = trimmed.split('*');
   if (parts.length !== 2) return null;

   const [rawName, rawDomain] = parts;
   if (!rawName || !rawDomain) return null;
   if (!NAME_PATTERN.test(rawName) || !NAME_PATTERN.test(rawDomain)) {
      return null;
   }

   const domain = rawDomain.toLowerCase();
   if (domain.length > 253) return null;

   const labels = domain.split('.');
   if (labels.length < 2) return null;
   if (!labels.every(label => DOMAIN_LABEL_PATTERN.test(label))) return null;
   if (!DOMAIN_TLD_PATTERN.test(labels[labels.length - 1])) return null;

   const name = rawName.toLowerCase();
   return { name, domain, address: `${name}*${domain}` };
}

function isResolution(value: unknown): value is FederationResolution {
   return (
      !!value &&
      typeof value === 'object' &&
      typeof (value as FederationResolution).accountId === 'string' &&
      (value as FederationResolution).accountId.length > 0
   );
}

function isNotFoundError(error: unknown): boolean {
   if (!error || typeof error !== 'object') return false;
   const candidate = error as {
      name?: string;
      status?: number;
      message?: string;
      response?: { status?: number };
   };
   return (
      candidate.name === 'NotFoundError' ||
      candidate.status === 404 ||
      candidate.response?.status === 404 ||
      /federation record not found/i.test(candidate.message ?? '')
   );
}

function isDnsNotFoundError(error: unknown): boolean {
   if (!error || typeof error !== 'object') return false;
   const code = (error as { code?: string }).code;
   return code === 'ENOTFOUND' || code === 'ENODATA' || code === 'EAI_NONAME';
}

function errorMessage(error: unknown): string {
   return error instanceof Error ? error.message : String(error);
}

/** Default resolver backed by the Stellar SDK's FederationServer. */
async function resolveWithStellarSdk(address: string): Promise<unknown> {
   const parsed = parseFederationAddress(address);
   if (!parsed) throw new FederationAddressError(address);

   // Loaded lazily so unit tests that inject `resolveFederation` do not need
   // to load the SDK (its ESM-only dependencies are not Jest-compatible).
   const { Federation } = await import('@stellar/stellar-sdk');

   // HTTP is disabled and the SDK timeout bounds each outbound call, while
   // the service applies an overall deadline on top of the SDK work.
   return Federation.Server.resolve(parsed.address, {
      allowHttp: false,
      timeout: FEDERATION_TIMEOUT_MS,
   });
}

/**
 * Resolves federation addresses with SSRF protection, timeout and Redis
 * caching. Dependencies are injectable so tests can run without DNS, Redis or
 * the network.
 */
export class FederationService {
   private readonly resolveFederation: (address: string) => Promise<unknown>;
   private readonly lookupHostname: LookupHostname;
   private readonly getCache: <T>(key: string) => Promise<T | null>;
   private readonly setCache: (
      key: string,
      value: unknown,
      ttlSeconds: number
   ) => Promise<void>;
   private readonly timeoutMs: number;

   constructor(dependencies: FederationServiceDependencies = {}) {
      this.resolveFederation =
         dependencies.resolveFederation ?? resolveWithStellarSdk;
      this.lookupHostname = dependencies.lookupHostname ?? hostnameToLookup;
      this.getCache = dependencies.getCache ?? cacheGetJson;
      this.setCache = dependencies.setCache ?? cacheSetJson;
      this.timeoutMs = dependencies.timeoutMs ?? FEDERATION_TIMEOUT_MS;
   }

   /**
    * Resolves a `name*domain` federation address.
    *
    * @throws {FederationAddressError} for malformed addresses.
    * @throws {FederationBlockedAddressError} when the domain resolves to
    * private, loopback or link-local address space.
    * @throws {FederationNotFoundError} when no record exists (also cached).
    * @throws {FederationTimeoutError} when the lookup exceeds 3 seconds.
    * @throws {FederationUpstreamError} when the federation server fails.
    */
   async resolve(address: string): Promise<FederationResolution> {
      const parsed = parseFederationAddress(address);
      if (!parsed) throw new FederationAddressError(address);

      const cacheKey = federationCacheKey(parsed.address);
      const negativeKey = federationNegativeCacheKey(parsed.address);

      const cached = await this.getCache<FederationResolution>(cacheKey);
      if (isResolution(cached)) return cached;

      const negative = await this.getCache<{ notFound: true }>(negativeKey);
      if (negative?.notFound) {
         throw new FederationNotFoundError(parsed.address);
      }

      // Never contact a domain that points at internal address space.
      let records;
      try {
         records = await this.lookupHostname(parsed.domain);
      } catch (error) {
         if (isDnsNotFoundError(error)) {
            throw await this.notFound(parsed.address, negativeKey, error);
         }
         throw new FederationUpstreamError(
            `DNS lookup for ${parsed.domain} failed: ${errorMessage(error)}`
         );
      }

      if (records.length === 0) {
         throw await this.notFound(parsed.address, negativeKey);
      }

      for (const record of records) {
         if (isBlockedIpAddress(record.address)) {
            throw new FederationBlockedAddressError(
               `Refusing to contact ${parsed.domain}: resolved address ${record.address} is not public`
            );
         }
      }

      let record: unknown;
      try {
         record = await this.withTimeout(
            this.resolveFederation(parsed.address),
            this.timeoutMs
         );
      } catch (error) {
         if (error instanceof FederationTimeoutError) throw error;
         if (isNotFoundError(error)) {
            throw await this.notFound(parsed.address, negativeKey, error);
         }
         logger.warn(
            {
               type: 'federation_lookup_failed',
               address: parsed.address,
               error: errorMessage(error),
            },
            'Federation server lookup failed'
         );
         throw new FederationUpstreamError(
            `Federation lookup for ${parsed.address} failed: ${errorMessage(
               error
            )}`
         );
      }

      const resolution = this.normaliseRecord(parsed.address, record);
      await this.setCache(cacheKey, resolution, FEDERATION_CACHE_TTL_SECONDS);
      return resolution;
   }

   private async notFound(
      address: string,
      negativeKey: string,
      cause?: unknown
   ): Promise<FederationNotFoundError> {
      if (cause) {
         logger.info(
            {
               type: 'federation_address_not_found',
               address,
               error: errorMessage(cause),
            },
            'Federation address not found'
         );
      }
      await this.setCache(
         negativeKey,
         { notFound: true },
         FEDERATION_NEGATIVE_CACHE_TTL_SECONDS
      );
      return new FederationNotFoundError(address);
   }

   private normaliseRecord(
      address: string,
      record: unknown
   ): FederationResolution {
      const candidate = record as {
         account_id?: unknown;
         memo?: unknown;
         memo_type?: unknown;
      } | null;

      const accountId = candidate?.account_id;
      if (
         typeof accountId !== 'string' ||
         !StrKey.isValidEd25519PublicKey(accountId)
      ) {
         throw new FederationUpstreamError(
            `Federation server returned an invalid record for ${address}`
         );
      }

      const resolution: FederationResolution = { accountId };
      if (typeof candidate?.memo === 'string') {
         resolution.memo = candidate.memo;
      }
      if (typeof candidate?.memo_type === 'string') {
         resolution.memoType = candidate.memo_type;
      }
      return resolution;
   }

   private async withTimeout<T>(
      promise: Promise<T>,
      timeoutMs: number
   ): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
         timer = setTimeout(
            () => reject(new FederationTimeoutError(timeoutMs)),
            timeoutMs
         );
      });

      try {
         return await Promise.race([promise, timeout]);
      } finally {
         if (timer) clearTimeout(timer);
      }
   }
}

/** Shared instance used by the HTTP route. */
export const federationService = new FederationService();

export default FederationService;
