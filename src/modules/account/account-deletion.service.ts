// src/modules/account/account-deletion.service.ts
// Account deletion with a grace period (#1325).
//
// Request -> 14-day grace period (cancellable) -> anonymization by the
// lifecycle worker. Deletion is refused while the account has outstanding
// obligations: open limit orders, active plans (pending scheduled transfers or
// active auto-invest rules) or unclaimed earnings.
//
// What anonymization does:
//   - User: email, names, phone, avatar, password hash and email verification
//     are replaced, so the person can no longer sign in or be identified.
//   - Creator profiles: public text is cleared and the handle is replaced.
//   - Comments and limit orders authored by the wallet are re-keyed to the
//     request's pseudonymId. Their content is kept where it does not identify.
//   - Alerts, watchlist entries and auto-invest rules are deleted.
//   - The StellarWallet link is removed. The wallet address on-chain (trades,
//     holdings, earnings) is public ledger data, and it is no longer linked to
//     any account, so it is pseudonymous. Those rows are not rewritten, so the
//     indexer's on-chain reconciliation keeps working.

import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import {
   DELETION_GRACE_PERIOD_MS,
   OPEN_LIMIT_ORDER_STATUSES,
} from './account.constants';

export interface DeletionBlocker {
   code: 'open_orders' | 'active_plans' | 'unclaimed_earnings';
   count: number;
   message: string;
}

export interface AccountDeletionView {
   id: string;
   status: string;
   requestedAt: string;
   scheduledFor: string;
   cancelledAt: string | null;
   completedAt: string | null;
}

export class DeletionBlockedError extends Error {
   constructor(public readonly blockers: DeletionBlocker[]) {
      super('Account deletion is blocked by outstanding obligations');
      this.name = 'DeletionBlockedError';
   }
}

export class DeletionAlreadyRequestedError extends Error {
   constructor() {
      super('An account deletion is already scheduled for this account');
      this.name = 'DeletionAlreadyRequestedError';
   }
}

export class NoPendingDeletionError extends Error {
   constructor() {
      super('No pending account deletion to cancel');
      this.name = 'NoPendingDeletionError';
   }
}

export class DeletionGracePeriodEndedError extends Error {
   constructor() {
      super('The grace period has ended; the deletion can no longer be cancelled');
      this.name = 'DeletionGracePeriodEndedError';
   }
}

export class AccountNotFoundError extends Error {
   constructor() {
      super('Account not found');
      this.name = 'AccountNotFoundError';
   }
}

export function createPseudonymId(): string {
   return `anon_${randomBytes(12).toString('hex')}`;
}

/** Outstanding obligations that block deletion, for the given wallet. */
export async function findDeletionBlockers(wallet: string | null): Promise<DeletionBlocker[]> {
   if (!wallet) return [];

   const [openOrders, pendingTransfers, activeRules, lpPositions, revenueClaims, dividendClaims] =
      await Promise.all([
         prisma.limitOrder.count({
            where: { wallet, status: { in: [...OPEN_LIMIT_ORDER_STATUSES] } },
         }),
         prisma.scheduledTransfer.count({ where: { sender: wallet, status: 'pending' } }),
         prisma.autoInvestRule.count({ where: { walletAddress: wallet, isActive: true } }),
         prisma.keyLpPosition.findMany({
            where: { wallet },
            select: { accruedRewards: true, claimedRewards: true },
         }),
         prisma.revenueClaim.count({
            where: { wallet, claimedAt: null, entitledAmountXlm: { gt: 0 } },
         }),
         prisma.dividendClaim.count({
            where: { recipientAddress: wallet, claimedAt: null, amountXlm: { gt: 0 } },
         }),
      ]);

   const unclaimedLpPositions = lpPositions.filter(position =>
      position.accruedRewards.minus(position.claimedRewards).greaterThan(0)
   ).length;
   const unclaimedEarnings = unclaimedLpPositions + revenueClaims + dividendClaims;
   const activePlans = pendingTransfers + activeRules;

   const blockers: DeletionBlocker[] = [];
   if (openOrders > 0) {
      blockers.push({
         code: 'open_orders',
         count: openOrders,
         message: `${openOrders} open limit order(s) must be filled or cancelled`,
      });
   }
   if (activePlans > 0) {
      blockers.push({
         code: 'active_plans',
         count: activePlans,
         message: `${activePlans} active plan(s) (scheduled transfers or auto-invest rules) must be stopped`,
      });
   }
   if (unclaimedEarnings > 0) {
      blockers.push({
         code: 'unclaimed_earnings',
         count: unclaimedEarnings,
         message: `${unclaimedEarnings} unclaimed earning(s) must be claimed`,
      });
   }
   return blockers;
}

function toDeletionView(row: {
   id: string;
   status: string;
   requestedAt: Date;
   scheduledFor: Date;
   cancelledAt: Date | null;
   completedAt: Date | null;
}): AccountDeletionView {
   return {
      id: row.id,
      status: row.status,
      requestedAt: row.requestedAt.toISOString(),
      scheduledFor: row.scheduledFor.toISOString(),
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
   };
}

/** Schedules deletion after the grace period, unless obligations block it. */
export async function requestAccountDeletion(
   userId: string,
   now: Date = new Date()
): Promise<AccountDeletionView> {
   const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, stellarWallet: { select: { address: true } } },
   });
   if (!user) throw new AccountNotFoundError();

   const existing = await prisma.deletionRequest.findFirst({
      where: { userId, status: { in: ['pending', 'processing'] } },
      select: { id: true },
   });
   if (existing) throw new DeletionAlreadyRequestedError();

   const blockers = await findDeletionBlockers(user.stellarWallet?.address ?? null);
   if (blockers.length > 0) throw new DeletionBlockedError(blockers);

   const row = await prisma.deletionRequest.create({
      data: {
         userId,
         pseudonymId: createPseudonymId(),
         scheduledFor: new Date(now.getTime() + DELETION_GRACE_PERIOD_MS),
      },
   });
   return toDeletionView(row);
}

/** Latest deletion request for the account, or null. */
export async function getAccountDeletion(userId: string): Promise<AccountDeletionView | null> {
   const row = await prisma.deletionRequest.findFirst({
      where: { userId },
      orderBy: { requestedAt: 'desc' },
   });
   return row ? toDeletionView(row) : null;
}

/** Cancels a pending deletion while its grace period is still running. */
export async function cancelAccountDeletion(
   userId: string,
   now: Date = new Date()
): Promise<AccountDeletionView> {
   const request = await prisma.deletionRequest.findFirst({
      where: { userId, status: { in: ['pending', 'processing'] } },
      orderBy: { requestedAt: 'desc' },
   });
   if (!request) throw new NoPendingDeletionError();
   if (request.status === 'processing' || request.scheduledFor.getTime() <= now.getTime()) {
      throw new DeletionGracePeriodEndedError();
   }

   const updated = await prisma.deletionRequest.updateMany({
      where: { id: request.id, status: 'pending' },
      data: { status: 'cancelled', cancelledAt: now },
   });
   if (updated.count === 0) throw new DeletionGracePeriodEndedError();

   return toDeletionView({ ...request, status: 'cancelled', cancelledAt: now });
}

interface DueDeletion {
   id: string;
   userId: string;
   pseudonymId: string;
}

/**
 * Anonymizes one account in a single transaction. Callers must have already
 * confirmed the account has no blockers.
 */
export async function anonymizeAccount(
   request: DueDeletion,
   now: Date = new Date()
): Promise<void> {
   const user = await prisma.user.findUnique({
      where: { id: request.userId },
      select: {
         id: true,
         stellarWallet: { select: { address: true } },
         creatorProfiles: { select: { id: true } },
      },
   });
   const wallet = user?.stellarWallet?.address ?? null;
   const pseudonym = request.pseudonymId;

   await prisma.$transaction(async tx => {
      if (user) {
         await tx.user.update({
            where: { id: user.id },
            data: {
               email: `deleted+${pseudonym}@deleted.invalid`,
               firstName: 'Deleted',
               lastName: 'User',
               phoneNumber: null,
               avatar: null,
               emailVerified: false,
               emailVerifiedAt: null,
               // Not a valid bcrypt hash, so password login can never match.
               passwordHash: `deleted:${pseudonym}`,
            },
         });

         for (const profile of user.creatorProfiles) {
            await tx.creatorProfile.update({
               where: { id: profile.id },
               data: {
                  handle: `deleted-${profile.id}`,
                  displayName: 'Deleted creator',
                  bio: null,
                  avatarUrl: null,
                  avatarCid: null,
                  twitter: null,
                  website: null,
                  discord: null,
                  perkSummary: null,
               },
            });
         }
      }

      await tx.dataExportJob.updateMany({
         where: { userId: request.userId },
         data: { status: 'expired', archive: Prisma.DbNull },
      });

      if (wallet) {
         await tx.comment.updateMany({
            where: { author: wallet },
            data: { author: pseudonym, body: '[deleted]' },
         });
         await tx.limitOrder.updateMany({
            where: { wallet },
            data: { wallet: pseudonym },
         });
         await tx.priceAlert.deleteMany({ where: { walletAddress: wallet } });
         await tx.investorWatchlist.deleteMany({ where: { walletAddress: wallet } });
         await tx.autoInvestRule.deleteMany({ where: { walletAddress: wallet } });
      }

      await tx.stellarWallet.deleteMany({ where: { userId: request.userId } });

      await tx.deletionRequest.update({
         where: { id: request.id },
         data: { status: 'completed', completedAt: now, error: null },
      });
   });
}

function errorMessage(error: unknown): string {
   return error instanceof Error ? error.message : String(error);
}

/**
 * Anonymizes accounts whose grace period has ended. Accounts that gained an
 * obligation during the grace period are deferred and stay cancellable. A
 * failed run is recorded on the request and retried on the next tick.
 */
export async function processDueDeletions(
   now: Date = new Date(),
   limit = 20
): Promise<{ completed: number; deferred: number; failed: number }> {
   const due = await prisma.deletionRequest.findMany({
      where: { status: 'pending', scheduledFor: { lte: now } },
      orderBy: { scheduledFor: 'asc' },
      take: limit,
      select: { id: true, userId: true, pseudonymId: true },
   });

   let completed = 0;
   let deferred = 0;
   let failed = 0;
   for (const request of due) {
      const claimed = await prisma.deletionRequest.updateMany({
         where: { id: request.id, status: 'pending' },
         data: { status: 'processing' },
      });
      if (claimed.count === 0) continue;

      try {
         const user = await prisma.user.findUnique({
            where: { id: request.userId },
            select: { stellarWallet: { select: { address: true } } },
         });
         const blockers = await findDeletionBlockers(user?.stellarWallet?.address ?? null);
         if (blockers.length > 0) {
            await prisma.deletionRequest.update({
               where: { id: request.id },
               data: {
                  status: 'pending',
                  error: `Deferred: ${blockers.map(blocker => blocker.message).join('; ')}`,
               },
            });
            deferred++;
            continue;
         }

         await anonymizeAccount(request, now);
         completed++;
      } catch (error) {
         await prisma.deletionRequest.update({
            where: { id: request.id },
            data: { status: 'pending', error: errorMessage(error) },
         });
         failed++;
      }
   }
   return { completed, deferred, failed };
}
