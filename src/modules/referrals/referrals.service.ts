// src/modules/referrals/referrals.service.ts
// Referral tracking and reward distribution (#910).
//
// Every wallet owns a referral code (`ReferralCode`). When a new wallet
// registers with that code (`POST /referrals/register`) a `Referral` row links
// the referee to the referrer, permanently: a wallet can be referred exactly
// once.
//
// Rewards are paid once per referee, on the referred wallet's first trade. The
// indexer calls `recordFirstTradeReferralReward` for every buy; the update that
// stamps `firstTradeAt` is conditional on it still being null, so concurrent
// events (or replays) for the same referee can only ever pay out once. The
// payout is written to the `ReferralEvent` fee ledger, which is what the
// earnings endpoint aggregates.

import crypto from 'crypto';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { envConfig } from '../../config';
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
} from './referrals.constants';
import {
   ReferredCursorPayload,
   ReferredWallet,
   ReferralEarnings,
   ReferralEarningsBreakdownItem,
   ReferralStatus,
   ReferredWalletsQuery,
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
      rows.map((row) => row.refereeAddress)
   );

   // `refereeAddress` is unique per referral, so it doubles as the key that
   // lets the cursor builder recover the row id of the page's last item.
   const cursorByReferee = new Map(
      rows.map((row) => [
         row.refereeAddress,
         encodeCursor({
            joinedAt: row.createdAt.toISOString(),
            id: row.id,
         }),
      ])
   );

   const items: ReferredWallet[] = rows.map((row) => ({
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
      (item) => cursorByReferee.get(item.refereeAddress) ?? ''
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
      breakdown: page.items.map((item) => ({
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

export interface FirstTradeReferralInput {
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
 * Pays the referrer a share of a referred wallet's first trade.
 *
 * The `firstTradeAt` stamp is conditional on it still being null, so only the
 * first trade a referred wallet completes ever pays out — later trades and
 * indexer replays are no-ops.
 *
 * @returns true when a reward was paid, false when the wallet was not
 *   referred or had already traded.
 */
export async function recordFirstTradeReferralReward(
   input: FirstTradeReferralInput
): Promise<boolean> {
   const refereeAddress = input.refereeAddress.trim();
   const tradeAt = input.tradeAt ?? new Date();
   const rewardXlm = roundXlm(
      (input.tradeValueXlm * envConfig.REFERRAL_REWARD_BPS) / 10_000
   );

   // Claim the first trade and write its fee in one transaction. If the fee
   // insert fails, the first-trade stamp rolls back too, allowing a replay to
   // retry instead of permanently losing the reward.
   const referrerAddress = await prisma.$transaction(async (tx) => {
      const claimed = await tx.referral.updateMany({
         where: { refereeAddress, firstTradeAt: null },
         data: { firstTradeAt: tradeAt, firstTradeKeyId: input.keyId },
      });

      // `count === 0` means the wallet is not referred, or a previous event
      // already claimed the reward.
      if (claimed.count === 0) {
         return null;
      }

      const referral = await tx.referral.findUnique({
         where: { refereeAddress },
         select: { referrerAddress: true },
      });
      if (!referral) {
         throw new Error(
            `Referral for wallet ${refereeAddress} disappeared while claiming its first trade`
         );
      }

      if (rewardXlm > 0) {
         await tx.referralEvent.create({
            data: {
               walletAddress: referral.referrerAddress,
               refereeAddress,
               keyId: input.keyId,
               amount: rewardXlm,
               ...(input.txHash ? { txHash: input.txHash } : {}),
               ...(input.eventIndex !== undefined && input.eventIndex !== null
                  ? { eventIndex: input.eventIndex }
                  : {}),
               createdAt: tradeAt,
            },
         });
      }

      return referral.referrerAddress;
   });

   if (!referrerAddress) {
      return false;
   }

   logger.info(
      {
         type: 'referral_first_trade_reward',
         referrerAddress,
         refereeAddress,
         keyId: input.keyId,
         rewardXlm,
         ...(input.txHash ? { txHash: input.txHash } : {}),
      },
      'Referral reward paid for referred wallet first trade'
   );

   return true;
}
