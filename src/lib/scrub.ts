// src/lib/scrub.ts
// Central PII and secret scrubbing applied before data leaves the process
// (logs, error reports, analytics payloads). See docs/logging-pii-scrubbing.md.
//
// The same rules back three integration points:
//   - pino: `createPinoScrubHooks` scrubs every log call (message and fields)
//   - pino serializers: `createScrubSerializer` for ad-hoc keys
//   - Sentry: `createSentryBeforeSend` for the `beforeSend` hook
//
// Wallet addresses are replaced with a keyed hash that rotates its salt
// periodically, so the same wallet correlates within one salt period but
// cannot be joined across periods.

import { createHmac, randomBytes } from 'crypto';

export const REDACTED = '[REDACTED]';

/**
 * Field names whose values are always redacted, whatever their depth.
 * Matching ignores case, `-` and `_`, so `api_key`, `apiKey` and `API-KEY`
 * all match `apikey`.
 */
const DEFAULT_SENSITIVE_FIELDS = [
   'password',
   'passwordhash',
   'passwd',
   'token',
   'accesstoken',
   'refreshtoken',
   'idtoken',
   'authorization',
   'cookie',
   'setcookie',
   'apikey',
   'secret',
   'clientsecret',
   'privatekey',
   'secretkey',
   'credential',
   'credentials',
   'passkey',
   'passkeycredential',
   'passkeypublickey',
   'sessiontoken',
];

/** Field names holding Stellar wallet addresses; values are hashed, not dropped. */
const WALLET_FIELDS = new Set([
   'wallet',
   'walletaddress',
   'owneraddress',
   'actor',
   'sourceaccount',
   'publickey',
]);

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;
const API_KEY_PATTERN = /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g;
const INLINE_SECRET_PATTERN =
   /((?:api[_-]?key|access[_-]?token|client[_-]?secret|password|secret)\s*[=:]\s*)([^\s,;&"']+)/gi;
/** Stellar secret seed (strkey, version byte S). Never log these. */
const STELLAR_SEED_PATTERN = /\bS[A-Z2-7]{55}\b/g;
/** Stellar account public key (strkey, version byte G). */
const STELLAR_ADDRESS_PATTERN = /\bG[A-Z2-7]{55}\b/g;
/** Anchored, non-global form for whole-value checks (no `lastIndex` state). */
const STELLAR_ADDRESS_EXACT = /^G[A-Z2-7]{55}$/;

const MAX_DEPTH = 16;

export interface WalletHasherOptions {
   /** Secret used to key the salt derivation. Random per process when omitted. */
   secret?: string;
   /** Salt rotation period in milliseconds. */
   rotationMs?: number;
   /** Clock injection for tests. */
   now?: () => number;
}

export type WalletHasher = (address: string) => string;

/**
 * Returns a wallet hasher whose salt changes every `rotationMs`.
 *
 * Within one period `hash(a) === hash(a)` so logs can be correlated; across
 * periods the same wallet hashes differently. Without `secret` the key is
 * random per process, so correlation then only holds within one process.
 */
export function createWalletHasher(options: WalletHasherOptions = {}): WalletHasher {
   const secret = options.secret ?? randomBytes(32).toString('hex');
   const rotationMs = options.rotationMs ?? 7 * 24 * 60 * 60 * 1000;
   const now = options.now ?? Date.now;

   let cachedPeriod = -1;
   let cachedSalt = '';

   return (address: string) => {
      const period = Math.floor(now() / rotationMs);
      if (period !== cachedPeriod) {
         cachedPeriod = period;
         cachedSalt = createHmac('sha256', secret)
            .update(`wallet-salt:${period}`)
            .digest('hex');
      }
      const digest = createHmac('sha256', cachedSalt).update(address).digest('hex');
      return `wallet_${digest.slice(0, 16)}`;
   };
}

export interface ScrubRules {
   /** Normalised field names (see `normaliseFieldName`) that are always redacted. */
   sensitiveFields: Set<string>;
   /** Replaces Stellar account addresses found in strings and wallet fields. */
   hashWallet: WalletHasher;
}

export interface ScrubRuleOptions {
   /** Deployment-specific field names, e.g. from SCRUB_EXTRA_FIELDS. */
   extraFields?: string[];
   walletHasher?: WalletHasher;
}

function normaliseFieldName(name: string): string {
   return name.toLowerCase().replace(/[-_]/g, '');
}

/** Builds scrub rules. Extra fields are merged with the defaults. */
export function createScrubRules(options: ScrubRuleOptions = {}): ScrubRules {
   const sensitiveFields = new Set(DEFAULT_SENSITIVE_FIELDS.map(normaliseFieldName));
   for (const field of options.extraFields ?? []) {
      const normalised = normaliseFieldName(field.trim());
      if (normalised.length > 0) sensitiveFields.add(normalised);
   }
   return {
      sensitiveFields,
      hashWallet: options.walletHasher ?? createWalletHasher(),
   };
}

/**
 * Builds scrub rules from process environment variables:
 * - `SCRUB_EXTRA_FIELDS`: comma-separated extra field names
 * - `SCRUB_WALLET_HASH_SECRET`: key for wallet salt derivation
 * - `SCRUB_WALLET_SALT_ROTATION_DAYS`: salt rotation period (default 7)
 */
export function createScrubRulesFromEnv(env: NodeJS.ProcessEnv = process.env): ScrubRules {
   const extraFields = (env.SCRUB_EXTRA_FIELDS ?? '')
      .split(',')
      .map(field => field.trim())
      .filter(Boolean);

   const rotationDays = Number(env.SCRUB_WALLET_SALT_ROTATION_DAYS);
   const rotationMs =
      Number.isFinite(rotationDays) && rotationDays > 0
         ? rotationDays * 24 * 60 * 60 * 1000
         : 7 * 24 * 60 * 60 * 1000;

   return createScrubRules({
      extraFields,
      walletHasher: createWalletHasher({
         secret: env.SCRUB_WALLET_HASH_SECRET || undefined,
         rotationMs,
      }),
   });
}

/** Scrubs secrets, emails and wallet addresses inside a string. */
export function scrubString(value: string, rules: ScrubRules): string {
   return value
      .replace(EMAIL_PATTERN, '[REDACTED:email]')
      .replace(BEARER_PATTERN, 'Bearer [REDACTED:token]')
      .replace(JWT_PATTERN, '[REDACTED:jwt]')
      .replace(API_KEY_PATTERN, '[REDACTED:api-key]')
      .replace(INLINE_SECRET_PATTERN, (_match, prefix: string) => `${prefix}[REDACTED:secret]`)
      .replace(STELLAR_SEED_PATTERN, '[REDACTED:seed]')
      .replace(STELLAR_ADDRESS_PATTERN, address => rules.hashWallet(address));
}

function scrubError(error: Error, rules: ScrubRules, depth: number, seen: WeakSet<object>): Record<string, unknown> {
   const out: Record<string, unknown> = {
      name: error.name,
      message: scrubString(error.message, rules),
      stack: error.stack ? scrubString(error.stack, rules) : undefined,
   };
   for (const [key, val] of Object.entries(error)) {
      out[key] = isSensitive(key, rules) ? REDACTED : scrubInner(val, rules, depth + 1, seen, key);
   }
   return out;
}

function isSensitive(key: string, rules: ScrubRules): boolean {
   return rules.sensitiveFields.has(normaliseFieldName(key));
}

function scrubInner(
   value: unknown,
   rules: ScrubRules,
   depth: number,
   seen: WeakSet<object>,
   parentKey?: string
): unknown {
   if (typeof value === 'string') {
      if (
         parentKey &&
         WALLET_FIELDS.has(normaliseFieldName(parentKey)) &&
         STELLAR_ADDRESS_EXACT.test(value)
      ) {
         return rules.hashWallet(value);
      }
      return scrubString(value, rules);
   }

   if (value === null || typeof value !== 'object') {
      // Primitives, bigint, symbols and functions pass through unchanged.
      return value;
   }

   if (value instanceof Date) return value;
   if (value instanceof Uint8Array) return value;

   if (depth > MAX_DEPTH) return '[Truncated]';
   if (seen.has(value)) return '[Circular]';
   seen.add(value);

   try {
      if (value instanceof Error) {
         return scrubError(value, rules, depth, seen);
      }

      if (Array.isArray(value)) {
         return value.map(item => scrubInner(item, rules, depth + 1, seen));
      }

      // Decimal-like and other value objects serialise through toJSON; scrub
      // the serialised form so their internals are not walked.
      const maybeToJson = (value as { toJSON?: unknown }).toJSON;
      if (typeof maybeToJson === 'function') {
         return scrubInner(maybeToJson.call(value), rules, depth + 1, seen, parentKey);
      }

      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
         out[key] = isSensitive(key, rules)
            ? REDACTED
            : scrubInner(val, rules, depth + 1, seen, key);
      }
      return out;
   } finally {
      seen.delete(value);
   }
}

/**
 * Returns a scrubbed deep copy of `value`. The input is never mutated.
 *
 * - Values under sensitive field names become `[REDACTED]`.
 * - Emails, bearer and JWT tokens, API keys and Stellar seeds inside strings
 *   are replaced with labelled placeholders.
 * - Stellar account addresses are hashed (see `createWalletHasher`).
 * - Errors are converted to plain objects with scrubbed message and stack.
 * - Circular references and objects nested deeper than 16 levels are cut.
 */
export function scrub(value: unknown, rules: ScrubRules = createScrubRules()): unknown {
   return scrubInner(value, rules, 0, new WeakSet<object>());
}

/** pino `hooks.logMethod` wiring: scrubs the message and every field argument. */
export function createPinoScrubHooks(rules: ScrubRules) {
   return {
      logMethod(
         this: unknown,
         args: unknown[],
         // pino's LogFn overloads cannot be expressed more narrowly here.
         // eslint-disable-next-line @typescript-eslint/no-explicit-any
         method: (...params: any[]) => void
      ): void {
         const scrubbed = args.map(arg => scrub(arg, rules));
         method.apply(this, scrubbed);
      },
   };
}

/** pino serializer for a single key, e.g. `serializers: { payload: createScrubSerializer(rules) }`. */
export function createScrubSerializer(rules: ScrubRules) {
   return (value: unknown): unknown => scrub(value, rules);
}

/** Minimal structural type for the parts of a Sentry event this module touches. */
export interface SentryLikeEvent {
   message?: string;
   user?: unknown;
   request?: { cookies?: unknown; headers?: unknown; [key: string]: unknown };
   [key: string]: unknown;
}

/**
 * Returns a Sentry `beforeSend` hook. Drops the `user` block entirely, removes
 * request cookies, and scrubs everything else with the same rules as the logs.
 *
 * The Sentry SDK is not a dependency of this server yet; the hook is ready to
 * be passed to `Sentry.init({ beforeSend })` once it is added.
 */
export function createSentryBeforeSend(rules: ScrubRules) {
   return <T extends SentryLikeEvent>(event: T): T => {
      const cleaned = scrub(event, rules) as T;
      delete cleaned.user;
      if (cleaned.request) {
         delete cleaned.request.cookies;
      }
      return cleaned;
   };
}
