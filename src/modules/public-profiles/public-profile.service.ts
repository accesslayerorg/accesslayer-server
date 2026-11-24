// src/modules/public-profiles/public-profile.service.ts
// Opt-in public portfolio profiles: handle registry, owner settings and the
// privacy-filtered public view (#1355).
//
// Visibility rules:
// - `enabled` false: the profile is served exactly like an unknown handle.
// - Each `show*` flag decides whether its field appears at all. A hidden field
//   is absent from the response, never nulled or approximated.
// - `showExactAmounts` decides how the visible amount fields (holdings, P&L,
//   key count) are published: exact values, or a fixed range bucket. Per-key
//   positions are only listed with exact amounts.
// - The wallet address appears only when `showWallet` is true.

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheInvalidate, cacheSetJson } from '../../utils/redis.utils';
import { getPortfolioPnl } from '../portfolio/portfolio-pnl.service';

export const PUBLIC_PROFILE_CACHE_TTL_SECONDS = 60;
const CACHE_PREFIX = 'public-profile:v1:';

export const HANDLE_PATTERN = /^[a-z0-9_]{3,30}$/;

/**
 * Handles that collide with routes, roles or platform pages. Compared after
 * lowercasing, so every casing is rejected.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
   'about', 'access', 'accesslayer', 'account', 'accounts', 'admin', 'administrator',
   'api', 'app', 'auth', 'billing', 'blog', 'collections', 'contact', 'creator',
   'creators', 'dashboard', 'docs', 'explore', 'faq', 'feed', 'help', 'home',
   'keys', 'legal', 'login', 'logout', 'me', 'mod', 'moderator', 'news',
   'notifications', 'official', 'portfolio', 'privacy', 'profile', 'profiles',
   'public', 'register', 'root', 'search', 'security', 'settings', 'signin',
   'signup', 'staff', 'status', 'support', 'system', 'team', 'terms', 'wallet',
   'wallets', 'www',
]);

/** Range used in place of an exact amount. `max` is exclusive; null means unbounded. */
export interface AmountRange {
   min: number;
   max: number | null;
}

/** Portfolio value and P&L buckets, in XLM. */
export const XLM_RANGE_BOUNDARIES = [0, 10, 100, 1_000, 10_000, 100_000, 1_000_000];
/** Distinct-keys-held buckets. */
export const KEY_COUNT_RANGE_BOUNDARIES = [0, 1, 5, 10, 25, 50, 100];

export function toRange(value: number, boundaries: number[]): AmountRange {
   const magnitude = Math.abs(value);
   let index = 0;
   while (index + 1 < boundaries.length && magnitude >= boundaries[index + 1]) {
      index += 1;
   }
   const min = boundaries[index];
   const max = index + 1 < boundaries.length ? boundaries[index + 1] : null;
   if (value >= 0) return { min, max };
   // Negative amounts mirror the positive bucket: -150 falls in [-1000, -100).
   return { min: max === null ? Number.NEGATIVE_INFINITY : -max, max: -min };
}

function serializeRange(range: AmountRange): { min: number | null; max: number | null } {
   // JSON has no infinity: an unbounded negative lower edge is published as null.
   return { min: Number.isFinite(range.min) ? range.min : null, max: range.max };
}

export class PublicProfileError extends Error {
   constructor(
      public readonly statusCode: number,
      public readonly code: string,
      message: string
   ) {
      super(message);
      this.name = 'PublicProfileError';
   }
}

export interface PublicProfileSettingsInput {
   handle: string;
   enabled?: boolean;
   showHoldings?: boolean;
   showPnl?: boolean;
   showKeyCount?: boolean;
   showJoined?: boolean;
   showWallet?: boolean;
   showExactAmounts?: boolean;
}

export interface PublicProfileView {
   handle: string;
   wallet?: string;
   joinedAt?: string;
   keyCount?: number | { min: number | null; max: number | null };
   holdings?:
      | {
           totalValueXlm: number;
           positions?: Array<{ keyId: string; quantity: number; valueXlm: number }>;
        }
      | { totalValueRangeXlm: { min: number | null; max: number | null } };
   pnl?:
      | { totalPnlXlm: number; realisedPnlXlm: number; unrealisedPnlXlm: number }
      | { totalPnlRangeXlm: { min: number | null; max: number | null } };
}

export function normalizeHandle(raw: string): string {
   return raw.trim().toLowerCase();
}

/** Throws a 400 PublicProfileError when the handle is malformed or reserved. */
export function assertValidHandle(handle: string): void {
   if (RESERVED_HANDLES.has(handle)) {
      throw new PublicProfileError(400, 'VALIDATION_ERROR', 'This handle is reserved');
   }
   if (!HANDLE_PATTERN.test(handle)) {
      throw new PublicProfileError(
         400,
         'VALIDATION_ERROR',
         'Handle must be 3 to 30 characters of lowercase letters, digits or underscores'
      );
   }
}

function cacheKey(handle: string): string {
   return `${CACHE_PREFIX}${handle}`;
}

const SETTINGS_SELECT = {
   handle: true,
   enabled: true,
   showHoldings: true,
   showPnl: true,
   showKeyCount: true,
   showJoined: true,
   showWallet: true,
   showExactAmounts: true,
   updatedAt: true,
} as const;

export async function getOwnPublicProfile(wallet: string) {
   return prisma.publicProfile.findUnique({ where: { wallet }, select: SETTINGS_SELECT });
}

/**
 * Creates or updates the caller's profile. Omitted flags keep their current
 * value (false for a new profile). Invalidates the cached public view of both
 * the previous and the new handle.
 */
export async function upsertPublicProfile(wallet: string, input: PublicProfileSettingsInput) {
   const handle = normalizeHandle(input.handle);
   assertValidHandle(handle);

   const holder = await prisma.publicProfile.findUnique({
      where: { handle },
      select: { wallet: true },
   });
   if (holder && holder.wallet !== wallet) {
      throw new PublicProfileError(409, 'CONFLICT', 'This handle is already taken');
   }

   const existing = await prisma.publicProfile.findUnique({
      where: { wallet },
      select: { handle: true },
   });

   const flags = {
      enabled: input.enabled,
      showHoldings: input.showHoldings,
      showPnl: input.showPnl,
      showKeyCount: input.showKeyCount,
      showJoined: input.showJoined,
      showWallet: input.showWallet,
      showExactAmounts: input.showExactAmounts,
   };
   const definedFlags = Object.fromEntries(
      Object.entries(flags).filter(([, value]) => value !== undefined)
   );

   let profile;
   try {
      profile = await prisma.publicProfile.upsert({
         where: { wallet },
         create: { wallet, handle, ...definedFlags },
         update: { handle, ...definedFlags },
         select: SETTINGS_SELECT,
      });
   } catch (error) {
      // Another wallet claimed the handle between the check and the write.
      if ((error as { code?: string })?.code === 'P2002') {
         throw new PublicProfileError(409, 'CONFLICT', 'This handle is already taken');
      }
      throw error;
   }

   const staleKeys = [cacheKey(handle)];
   if (existing && existing.handle !== handle) staleKeys.push(cacheKey(existing.handle));
   await cacheInvalidate(...staleKeys);

   return profile;
}

function round7(value: number): number {
   return Number(value.toFixed(7));
}

async function buildPublicView(profile: {
   wallet: string;
   handle: string;
   showHoldings: boolean;
   showPnl: boolean;
   showKeyCount: boolean;
   showJoined: boolean;
   showWallet: boolean;
   showExactAmounts: boolean;
   createdAt: Date;
}): Promise<PublicProfileView> {
   const view: PublicProfileView = { handle: profile.handle };
   const exact = profile.showExactAmounts;

   if (profile.showWallet) view.wallet = profile.wallet;

   if (profile.showJoined) {
      const stellarWallet = await prisma.stellarWallet.findUnique({
         where: { address: profile.wallet },
         select: { createdAt: true },
      });
      // Day precision is enough for a "joined" label and avoids publishing
      // the exact signup instant.
      view.joinedAt = (stellarWallet?.createdAt ?? profile.createdAt).toISOString().slice(0, 10);
   }

   if (profile.showHoldings || profile.showPnl || profile.showKeyCount) {
      const { positions, summary } = await getPortfolioPnl(profile.wallet);

      if (profile.showKeyCount) {
         view.keyCount = exact
            ? summary.positionCount
            : serializeRange(toRange(summary.positionCount, KEY_COUNT_RANGE_BOUNDARIES));
      }

      if (profile.showHoldings) {
         // The positions list reveals the key count through its length, so it
         // is only published when the key count itself is visible.
         view.holdings = exact
            ? {
                 totalValueXlm: summary.totalCurrentValue,
                 ...(profile.showKeyCount
                    ? {
                         positions: positions.map(p => ({
                            keyId: p.keyId,
                            quantity: p.quantity,
                            valueXlm: p.currentValue,
                         })),
                      }
                    : {}),
              }
            : {
                 totalValueRangeXlm: serializeRange(
                    toRange(summary.totalCurrentValue, XLM_RANGE_BOUNDARIES)
                 ),
              };
      }

      if (profile.showPnl) {
         const totalPnl = round7(summary.totalRealisedPnl + summary.totalUnrealisedPnl);
         view.pnl = exact
            ? {
                 totalPnlXlm: totalPnl,
                 realisedPnlXlm: summary.totalRealisedPnl,
                 unrealisedPnlXlm: summary.totalUnrealisedPnl,
              }
            : { totalPnlRangeXlm: serializeRange(toRange(totalPnl, XLM_RANGE_BOUNDARIES)) };
      }
   }

   return view;
}

/**
 * Public view for a handle, or null when the handle is unknown or the profile
 * is disabled. Callers must treat both null cases identically.
 */
export async function getPublicProfileView(rawHandle: string): Promise<PublicProfileView | null> {
   const handle = normalizeHandle(rawHandle);
   if (!HANDLE_PATTERN.test(handle)) return null;

   const cached = await cacheGetJson<PublicProfileView>(cacheKey(handle));
   if (cached) return cached;

   const profile = await prisma.publicProfile.findUnique({ where: { handle } });
   if (!profile || !profile.enabled) return null;

   const view = await buildPublicView(profile);
   await cacheSetJson(cacheKey(handle), view, PUBLIC_PROFILE_CACHE_TTL_SECONDS);
   return view;
}
