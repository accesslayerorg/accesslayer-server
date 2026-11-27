// src/modules/referrals/referrals.service.ts
// Referral tracking and reward distribution (#1198).
//
// Every wallet owns a referral code (`ReferralCode`). When a new wallet
// registers with that code (`POST /referrals/register`) a `Referral` row links
// the referee to the referrer, permanently: a wallet can be referred exactly
// once.
//
// Rewards are paid on every referred trade. The indexer calls
// `recordTradeReferralReward` for every buy/sell; the reward is calculated as:
//   reward = trade_value * protocol_fee_bps / 10000 * REFERRAL_REWARD_BPS / 10000 * tier_multiplier
// Tier multipliers: 1x (0-9 referrals), 1.5x (10-49), 2x (50+).
// The payout is written to the `ReferralEvent` fee ledger.

import crypto from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { envConfig } from '../../config';
import {
   ReferralAbuseDecision,
   ReferralAbuseService,
} from '../../services/referral-abuse.service';
import { prefetchFundingSource } from '../../services/wallet-funding.service';
import { loadProtocolFeeBps } from '../keys/key-fees.service';
import {
   buildPaginatedResponse,
   PaginatedResponse,
} from '../../utils/pagination.utils';
import {
   decodeCursor,
   encodeCursor,
   CursorChecksumError,
} from '../../utils/cursor.utils';
import {
   DEFAULT_REFERRED_PAGE_SIZE,
   REFERRAL_CODE_ALPHABET,
   REFERRAL_CODE_LENGTH,
   REFERRAL_CODE_MAX_ATTEMPTS,
   XLM_DECIMALS,
   getTierMultiplier,
   getTierName,
} from './referrals.constants';
import {
   ReferredCursorPayload,
   ReferredWallet,
   ReferralEarnings,
   ReferralEarningsBreakdownItem,
   ReferralStatus,
   ReferredWalletsQuery,
   ReferralStats,
} from './referrals.schemas';

/** Thrown when the supplied referral code has no owner. */
export class ReferralCodeNotFoundError extends Error {
   constructor() {
      super('Referral code not found');
      this.name = 'ReferralCodeNotFoundError';
   }
}

/** Thrown when the referee has already been referred by another wallet. */
export class AlreadyReferredError extends Error {
   constructor(refereeAddress: string) {
      super(`Wallet ${refereeAddress} has already been referred`);
      this.name = 'AlreadyReferredError';
   }
}

/** Thrown when a wallet tries to register with its own referral code. */
export class SelfReferralError extends Error {
   constructor(wallet: string) {
      super(`Wallet ${wallet} cannot refer itself`);
      this.name = 'SelfReferralError';
   }
}

/**
 * Detects a Prisma unique-constraint violation (P2002).
 *
 * Matched on the error code rather than `instanceof` so the check keeps
 * working when the Prisma namespace is stubbed out (unit tests) or when a
 * different Prisma client instance constructed the error.
 */
function isUniqueViolation(error: unknown): boolean {
   if (typeof error !== 'object' || error === null) return false;
   const { code, name } = error as { code?: unknown; name?: unknown };
   if (code !== 'P2002') return false;
   return name === undefined || name === 'PrismaClientKnownRequestError';
}

/** Rounds an XLM amount to Stellar's 7 decimal places. */
export function roundXlm(amount: number): number {
   return Number(amount.toFixed(XLM_DECIMALS));
}

/**
 * Generates a referral code from a CSPRNG. The alphabet excludes characters
 * that are easy to confuse when a code is read out loud or copied by hand.
 */
export function generateReferralCode(): string {
   const alphabet = REFERRAL_CODE_ALPHABET;
   // Rejection sampling keeps the distribution uniform across the alphabet.
   const maxUnbiased = Math.floor(256 / alphabet.length) * alphabet.length;
   let code = '';
   while (code.length < REFERRAL_CODE_LENGTH) {
      const bytes = crypto.randomBytes(REFERRAL_CODE_LENGTH);
      for (const byte of bytes) {
         if (byte >= maxUnbiased) continue;
         code += alphabet[byte % alphabet.length];
         if (code.length === REFERRAL_CODE_LENGTH) break;
      }
   }
   return code;
}

/**
 * Returns the wallet's referral code, creating one on first use so every
 * wallet always has a code to share.
 */
export async function getOrCreateReferralCode(wallet: string): Promise<string> {
   const address = wallet.trim();

   for (let attempt = 0; attempt < REFERRAL_CODE_MAX_ATTEMPTS; attempt += 1) {
      const existing = await prisma.referralCode.findUnique({
         where: { walletAddress: address },
         select: { code: true },
      });
      if (existing) {
         return existing.code;
      }

      try {
         const created = await prisma.referralCode.create({
            data: { walletAddress: address, code: generateReferralCode() },
            select: { code: true },
         });
         return created.code;
      } catch (error) {
         // Another request created the row (or claimed the generated code)
         // first: re-read on the next iteration instead of failing.
         if (!isUniqueViolation(error)) {
            throw error;
         }
      }
   }

   // Exhausted the retry budget: surface the last known state if the code row
   // exists by now, otherwise fail loudly rather than returning a wrong code.
   const existing = await prisma.referralCode.findUnique({
      where: { walletAddress: address },
      select: { code: true },
   });
   if (!existing) {
      throw new Error(
         `Unable to generate a unique referral code for ${address}`
      );
   }
   return existing.code;
}

export interface RegisteredReferral {
   referralId: string;
   referrerAddress: string;
   refereeAddress: string;
   referralCode: string;
   joinedAt: string;
   status: ReferralStatus;
}

/**
 * Links `refereeAddress` to the owner of `code`.
 *
 * @throws {ReferralCodeNotFoundError} when no wallet owns the code
 * @throws {SelfReferralError} when the referee owns the code itself
 * @throws {AlreadyReferredError} when the referee was already referred
 */
export async function registerReferral(
   refereeAddress: string,
   code: string
): Promise<RegisteredReferral> {
   const referee = refereeAddress.trim();
   const normalizedCode = code.trim().toUpperCase();

   const referralCode = await prisma.referralCode.findUnique({
      where: { code: normalizedCode },
      select: { walletAddress: true },
   });

   if (!referralCode) {
      throw new ReferralCodeNotFoundError();
   }

   if (referralCode.walletAddress === referee) {
      throw new SelfReferralError(referee);
   }

   const alreadyReferred = await prisma.referral.findUnique({
      where: { refereeAddress: referee },
      select: { referrerAddress: true },
   });
   if (alreadyReferred) {
      throw new AlreadyReferredError(referee);
   }

   try {
      const referral = await prisma.referral.create({
         data: {
            referrerAddress: referralCode.walletAddress,
            refereeAddress: referee,
            referralCode: normalizedCode,
         },
      });

      logger.info(
         {
            type: 'referral_registered',
            referrerAddress: referral.referrerAddress,
            refereeAddress: referral.refereeAddress,
         },
         'Referral relationship registered'
      );

      // Resolve the referee's funding source now (best effort, never throws)
      // so a sybil cluster is visible before any of its members trade (#1241).
      await prefetchFundingSource(referee);

      return {
         referralId: referral.id,
         referrerAddress: referral.referrerAddress,
         refereeAddress: referral.refereeAddress,
         referralCode: referral.referralCode,
         joinedAt: referral.createdAt.toISOString(),
         status: 'PENDING',
      };
   } catch (error) {
      // Lost a race against a concurrent registration for the same referee:
      // the unique index on `refereeAddress` is the source of truth.
      if (isUniqueViolation(error)) {
         throw new AlreadyReferredError(referee);
      }
      throw error;
   }
}

function parseReferredCursor(
   cursor: string | undefined
): ReferredCursorPayload | null {
   if (!cursor) return null;

   let payload: ReferredCursorPayload;
   try {
      payload = decodeCursor<ReferredCursorPayload>(cursor);
   } catch {
      throw new CursorChecksumError('Invalid cursor');
   }

   if (
      typeof payload?.joinedAt !== 'string' ||
      Number.isNaN(new Date(payload.joinedAt).getTime()) ||
      typeof payload?.id !== 'string'
   ) {
      throw new CursorChecksumError('Invalid cursor');
   }

   return payload;
}

function toStatus(firstTradeAt: Date | null): ReferralStatus {
   return firstTradeAt ? 'ACTIVE' : 'PENDING';
}

/**
 * Sums the referral fees earned per referred wallet, restricted to the
 * referees on the current page so the aggregate never scans the whole ledger.
 */
async function sumEarnedByReferee(
   referrerAddress: string,
   refereeAddresses: string[]
): Promise<Map<string, number>> {
   if (refereeAddresses.length === 0) {
      return new Map();
   }

   const grouped = await prisma.referralEvent.groupBy({
      by: ['refereeAddress'],
      where: {
         walletAddress: referrerAddress,
         refereeAddress: { in: refereeAddresses },
      },
      _sum: { amount: true },
   });

   const earned = new Map<string, number>();
   for (const row of grouped) {
      if (!row.refereeAddress) continue;
      earned.set(row.refereeAddress, Number(row._sum.amount ?? 0));
   }
   return earned;
}

/**
 * One cursor-paginated page of a wallet's referred wallets, newest first,
 * annotated with the reward each referee has earned so far.
 */
export async function listReferredWallets(
   referrerAddress: string,
   query: ReferredWalletsQuery = { limit: DEFAULT_REFERRED_PAGE_SIZE }
): Promise<PaginatedResponse<ReferredWallet>> {
   const cursor = parseReferredCursor(query.cursor);
   const limit = query.limit ?? DEFAULT_REFERRED_PAGE_SIZE;

   const rows = await prisma.referral.findMany({
      where: {
         referrerAddress,
         ...(cursor
            ? {
                 OR: [
                    { createdAt: { lt: new Date(cursor.joinedAt) } },
                    {
                       createdAt: { lte: new Date(cursor.joinedAt) },
                       id: { lt: cursor.id },
                    },
                 ],
              }
            : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
   });

   const earned = await sumEarnedByReferee(
      referrerAddress,
      rows.map((row: { refereeAddress: string }) => row.refereeAddress)
   );

   // `refereeAddress` is unique per referral, so it doubles as the key that
   // lets the cursor builder recover the row id of the page's last item.
   const cursorByReferee = new Map<string, string>(
      rows.map((row: { refereeAddress: string; createdAt: Date; id: string }) => [
         row.refereeAddress,
         encodeCursor({
            joinedAt: row.createdAt.toISOString(),
            id: row.id,
         }),
      ])
   );

   const items: ReferredWallet[] = rows.map((row: { refereeAddress: string; createdAt: Date; firstTradeAt: Date | null }) => ({
      refereeAddress: row.refereeAddress,
      joinedAt: row.createdAt.toISOString(),
      firstTradeAt: row.firstTradeAt ? row.firstTradeAt.toISOString() : null,
      hasCompletedFirstTrade: row.firstTradeAt !== null,
      status: toStatus(row.firstTradeAt),
      earnedXlm: roundXlm(earned.get(row.refereeAddress) ?? 0),
   }));

   return buildPaginatedResponse(
      items,
      limit,
      (item: ReferredWallet) => cursorByReferee.get(item.refereeAddress) ?? ''
   );
}

export interface ReferralEarningsResult extends ReferralEarnings {
   breakdown: ReferralEarningsBreakdownItem[];
   pagination: {
      limit: number;
      nextCursor: string | null;
      hasMore: boolean;
   };
}

/**
 * Total XLM earned by a wallet from referrals plus a per-referral breakdown.
 *
 * `totalEarned` is summed from the `ReferralEvent` fee ledger so it also
 * accounts for fees that were not attributed to a specific referee. The
 * breakdown covers the referee's registered referrals on the current page.
 */
export async function getReferralEarnings(
   referrerAddress: string,
   query: ReferredWalletsQuery = { limit: DEFAULT_REFERRED_PAGE_SIZE }
): Promise<ReferralEarningsResult> {
   const limit = query.limit ?? DEFAULT_REFERRED_PAGE_SIZE;

   const [referralCode, aggregate, referredCount, rewardedReferralCount, page] =
      await Promise.all([
         getOrCreateReferralCode(referrerAddress),
         prisma.referralEvent.aggregate({
            where: { walletAddress: referrerAddress },
            _sum: { amount: true },
         }),
         prisma.referral.count({ where: { referrerAddress } }),
         prisma.referral.count({
            where: { referrerAddress, firstTradeAt: { not: null } },
         }),
         listReferredWallets(referrerAddress, { ...query, limit }),
      ]);

   return {
      referralCode,
      totalEarned: roundXlm(Number(aggregate._sum.amount ?? 0)),
      rewardedReferralCount,
      referredCount,
      breakdown: page.items.map((item: ReferredWallet) => ({
         refereeAddress: item.refereeAddress,
         joinedAt: item.joinedAt,
         firstTradeAt: item.firstTradeAt,
         status: item.status,
         earnedXlm: item.earnedXlm,
      })),
      pagination: {
         limit,
         nextCursor: page.next_cursor,
         hasMore: page.has_more,
      },
   };
}

/**
 * Returns referral statistics for a wallet: referral count, tier, total earned, and pending claim.
 * This is used by GET /wallets/:address/referrals.
 */
export async function getReferralStats(
   referrerAddress: string
): Promise<ReferralStats> {
   const [referralCount, aggregate] = await Promise.all([
      prisma.referral.count({ where: { referrerAddress } }),
      prisma.referralEvent.aggregate({
         where: { walletAddress: referrerAddress },
         _sum: { amount: true },
      }),
   ]);

   const totalEarned = roundXlm(Number(aggregate._sum.amount ?? 0));
   const tier = getTierName(referralCount);

   // For now, pendingClaim is the same as totalEarned since there's no separate claim mechanism
   // In the future, this could track unclaimed rewards separately
   const pendingClaim = totalEarned;

   return {
      referralCount,
      tier,
      totalEarned,
      pendingClaim,
   };
}

export interface TradeReferralInput {
   /** Wallet that executed the trade. */
   refereeAddress: string;
   /** Key (creator id) that was traded. */
   keyId: string;
   /** Total XLM value of the trade, used to size the reward. */
   tradeValueXlm: number;
   txHash?: string | null;
   eventIndex?: number | null;
   tradeAt?: Date;
}

/**
 * Pays the referrer a share of a referred wallet's trade fee.
 *
 * Reward = trade_value * protocol_fee_bps / 10000 * REFERRAL_REWARD_BPS / 10000 * tier_multiplier
 * Tier multipliers: 1x (0-9 referrals), 1.5x (10-49), 2x (50+)
 *
 * This is called for EVERY trade by a referred wallet, not just the first trade.
 *
 * @returns true when a reward was paid, false when the wallet was not referred.
 */
export async function recordTradeReferralReward(
   input: TradeReferralInput
): Promise<boolean> {
   const refereeAddress = input.refereeAddress.trim();
   const tradeAt = input.tradeAt ?? new Date();

   // Find the referral to get the referrer
   const referral = await prisma.referral.findUnique({
      where: { refereeAddress },
      select: { id: true, referrerAddress: true },
   });

   // Wallet is not referred
   if (!referral) {
      return false;
   }

   const referrerAddress = referral.referrerAddress;

   // Verdict from an earlier trade (#1241). A rejected referral never earns;
   // a pending one has every reward withheld until an admin releases it.
   const existingHold = await prisma.referralHold.findUnique({
      where: { referralId: referral.id },
      select: { id: true, status: true },
   });
   if (existingHold?.status === 'REJECTED') {
      return false;
   }

   // Get the current referral count for the referrer to determine tier
   const referralCount = await prisma.referral.count({
      where: { referrerAddress },
   });

   // Get protocol fee
   const protocolFeeBps = await loadProtocolFeeBps();

   // Calculate reward: trade_value * protocol_fee_bps/10000 * REFERRAL_REWARD_BPS/10000 * tier_multiplier
   const tierMultiplier = getTierMultiplier(referralCount);
   const tradeFeeXlm = (input.tradeValueXlm * protocolFeeBps) / 10_000;
   const referralRate = envConfig.REFERRAL_REWARD_BPS / 10_000;
   const rewardXlm = roundXlm(tradeFeeXlm * referralRate * tierMultiplier);

   if (rewardXlm <= 0) {
      return false;
   }

   // Abuse detection (#1241) runs until the referral has a verdict. It may
   // call Horizon, which must never happen inside a database transaction, and
   // a Horizon outage throws here so the indexer retries the event instead of
   // paying an unchecked reward.
   let withhold = existingHold?.status === 'PENDING';
   let verdict: Exclude<ReferralAbuseDecision, { action: 'allow' }> | null =
      null;
   if (!existingHold) {
      const decision = await ReferralAbuseService.evaluate({
         referrerAddress,
         refereeAddress,
      });
      if (decision.action !== 'allow') {
         verdict = decision;
         withhold = true;
      }
   }

   if (withhold) {
      const outcome = await prisma.$transaction(async (tx) => {
         // The first flagged trade records the verdict; concurrent trades for
         // the same referee converge on the same row.
         const hold =
            existingHold ??
            (await tx.referralHold.upsert({
               where: { referralId: referral.id },
               create: {
                  referralId: referral.id,
                  reason: verdict!.reason,
                  status: verdict!.action === 'reject' ? 'REJECTED' : 'PENDING',
                  details: verdict!.details as Prisma.InputJsonValue,
                  referrerAddress,
                  refereeAddress,
               },
               update: {},
               select: { id: true, status: true },
            }));

         if (hold.status === 'REJECTED') {
            return 'rejected' as const;
         }

         // Touching the row takes its lock, serialising this insert against a
         // concurrent release: either the release sees this reward when it
         // reads the withheld rows, or this update sees RELEASED and the
         // reward is paid directly below. A reward can never be orphaned.
         const locked = await tx.referralHold.updateMany({
            where: { id: hold.id, status: 'PENDING' },
            data: { updatedAt: new Date() },
         });
         if (locked.count === 0) {
            return 'released' as const;
         }

         await tx.referralHoldReward.create({
            data: {
               holdId: hold.id,
               keyId: input.keyId,
               rewardXlm,
               tierMultiplier,
               txHash: input.txHash ?? null,
               eventIndex: input.eventIndex ?? null,
               tradedAt: tradeAt,
            },
         });
         return 'withheld' as const;
      });

      if (outcome !== 'released') {
         logger.warn(
            {
               type: 'referral_reward_withheld',
               referrerAddress,
               refereeAddress,
               keyId: input.keyId,
               rewardXlm,
               outcome,
               ...(verdict ? { reason: verdict.reason } : {}),
            },
            'Referral reward withheld by abuse detection'
         );
         return false;
      }
      // Released while this trade was in flight: pay it normally.
   }

   // Write the referral event
   await prisma.referralEvent.create({
      data: {
         walletAddress: referrerAddress,
         refereeAddress,
         keyId: input.keyId,
         amount: rewardXlm,
         tierMultiplier,
         ...(input.txHash ? { txHash: input.txHash } : {}),
         ...(input.eventIndex !== undefined && input.eventIndex !== null
            ? { eventIndex: input.eventIndex }
            : {}),
         createdAt: tradeAt,
      },
   });

   logger.info(
      {
         type: 'referral_trade_reward',
         referrerAddress,
         refereeAddress,
         keyId: input.keyId,
         rewardXlm,
         tierMultiplier,
         referralCount,
         ...(input.txHash ? { txHash: input.txHash } : {}),
      },
      'Referral reward paid for referred wallet trade'
   );

   return true;
}