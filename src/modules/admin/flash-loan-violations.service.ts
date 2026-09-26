// src/modules/admin/flash-loan-violations.service.ts
// Admin read model for indexed flash loan guard violations (#938).
//
// Wallets are grouped by violation frequency (most attempts first). Counts
// only include violations that have not aged out of the cooldown window
// unless `include_cleared` is requested.

import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';
import { FlashLoanViolationsQuery } from './flash-loan-violations.schemas';

export interface FlashLoanViolationEntry {
   keyId: string | null;
   ledger: number;
   txHash: string;
   eventIndex: number;
   occurredAt: string;
   clearedAt: string | null;
}

export interface FlashLoanViolationSummary {
   walletAddress: string;
   violationCount: number;
   keyIds: string[];
   firstViolationAt: string | null;
   lastViolationAt: string | null;
   alerted: boolean;
   alertedAt: string | null;
   alertCount: number;
   suspended: boolean;
   suspendedAt: string | null;
   suspensionExpiresAt: string | null;
   recentViolations: FlashLoanViolationEntry[];
}

export interface FlashLoanViolationsResponse {
   threshold: number;
   autoSuspendEnabled: boolean;
   cooldownHours: number;
   total: number;
   limit: number;
   offset: number;
   violations: FlashLoanViolationSummary[];
}

export async function getFlashLoanViolations(
   query: FlashLoanViolationsQuery
): Promise<FlashLoanViolationsResponse> {
   const where: Prisma.FlashLoanViolationWhereInput = query.include_cleared
      ? {}
      : { clearedAt: null };

   const [groups, distinctWallets] = await Promise.all([
      prisma.flashLoanViolation.groupBy({
         by: ['walletAddress'],
         where,
         _count: { _all: true },
         _min: { occurredAt: true },
         _max: { occurredAt: true },
         orderBy: { _count: { walletAddress: 'desc' } },
         take: query.limit,
         skip: query.offset,
      }),
      prisma.flashLoanViolation.findMany({
         where,
         distinct: ['walletAddress'],
         select: { walletAddress: true },
      }),
   ]);

   const walletAddresses = groups.map(group => group.walletAddress);
   const now = new Date();

   const statuses =
      walletAddresses.length > 0
         ? await prisma.flashLoanGuardStatus.findMany({
              where: { walletAddress: { in: walletAddresses } },
           })
         : [];

   const recentViolations =
      walletAddresses.length > 0 && query.recent_limit > 0
         ? await prisma.flashLoanViolation.findMany({
              where: { ...where, walletAddress: { in: walletAddresses } },
              orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
              take: walletAddresses.length * query.recent_limit,
           })
         : [];

   const statusByWallet = new Map(
      statuses.map(status => [status.walletAddress, status])
   );

   const recentByWallet = new Map<string, FlashLoanViolationEntry[]>();
   for (const violation of recentViolations) {
      const bucket = recentByWallet.get(violation.walletAddress) ?? [];
      if (bucket.length >= query.recent_limit) {
         continue;
      }
      bucket.push({
         keyId: violation.keyId,
         ledger: violation.ledger,
         txHash: violation.txHash,
         eventIndex: violation.eventIndex,
         occurredAt: violation.occurredAt.toISOString(),
         clearedAt: violation.clearedAt ? violation.clearedAt.toISOString() : null,
      });
      recentByWallet.set(violation.walletAddress, bucket);
   }

   const violations: FlashLoanViolationSummary[] = groups.map(group => {
      const status = statusByWallet.get(group.walletAddress);
      const recent = recentByWallet.get(group.walletAddress) ?? [];
      const suspended = isActiveSuspension(
         status?.suspendedAt ?? null,
         status?.suspensionExpiresAt ?? null,
         now
      );

      return {
         walletAddress: group.walletAddress,
         violationCount: group._count._all,
         keyIds: [
            ...new Set(
               recent
                  .map(entry => entry.keyId)
                  .filter((keyId): keyId is string => keyId !== null)
            ),
         ],
         firstViolationAt: group._min.occurredAt?.toISOString() ?? null,
         lastViolationAt: group._max.occurredAt?.toISOString() ?? null,
         alerted: Boolean(status?.alertedAt),
         alertedAt: status?.alertedAt?.toISOString() ?? null,
         alertCount: status?.alertCount ?? 0,
         suspended,
         suspendedAt: suspended ? status?.suspendedAt?.toISOString() ?? null : null,
         suspensionExpiresAt: suspended
            ? status?.suspensionExpiresAt?.toISOString() ?? null
            : null,
         recentViolations: recent,
      };
   });

   return {
      threshold: envConfig.FLASH_LOAN_VIOLATION_THRESHOLD,
      autoSuspendEnabled: envConfig.FLASH_LOAN_AUTO_SUSPEND_ENABLED,
      cooldownHours: envConfig.FLASH_LOAN_VIOLATION_COOLDOWN_HOURS,
      total: distinctWallets.length,
      limit: query.limit,
      offset: query.offset,
      violations,
   };
}

function isActiveSuspension(
   suspendedAt: Date | null,
   suspensionExpiresAt: Date | null,
   now: Date
): boolean {
   if (!suspendedAt) {
      return false;
   }
   return suspensionExpiresAt === null || suspensionExpiresAt > now;
}
