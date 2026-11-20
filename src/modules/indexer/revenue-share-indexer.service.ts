import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import { revenueDistributionCachePattern } from '../revenue/revenue-distributions.service';

const REVENUE_DISTRIBUTION_EVENT_TYPES = new Set([
   'RevenueDistributed',
   'REVENUE_DISTRIBUTED',
]);
const REVENUE_CLAIM_EVENT_TYPES = new Set([
   'RevenueShareClaimed',
   'REVENUE_SHARE_CLAIMED',
]);

function readString(
   event: IndexerChainEvent,
   ...names: string[]
): string | null {
   for (const name of names) {
      const value = event[name];
      if (
         (typeof value === 'string' || typeof value === 'number') &&
         String(value).trim() !== ''
      ) {
         return String(value);
      }
   }
   return null;
}

function readDate(value: unknown): Date | null {
   const date =
      typeof value === 'number'
         ? new Date(value < 100_000_000_000 ? value * 1000 : value)
         : value instanceof Date
           ? new Date(value.getTime())
           : typeof value === 'string'
             ? new Date(value)
             : null;
   return date && Number.isFinite(date.getTime()) ? date : null;
}

function readAmount(value: unknown): string | null {
   if (
      (typeof value !== 'string' &&
         typeof value !== 'number' &&
         typeof value !== 'bigint') ||
      String(value).trim() === ''
   ) {
      return null;
   }
   const amount = Number(value);
   return Number.isFinite(amount) && amount >= 0 ? String(value) : null;
}

function isUniqueConstraintError(error: unknown): boolean {
   return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
   );
}

function eventId(event: IndexerChainEvent): string {
   return `${event.txHash}:${event.eventIndex}`;
}

async function processRevenueDistributedEvent(
   event: IndexerChainEvent
): Promise<void> {
   const keyId = readString(
      event,
      'keyId',
      'key_id',
      'creatorId',
      'creator_id'
   );
   const amount = readAmount(
      event.totalAmount ??
         event.total_amount ??
         event.totalDistributed ??
         event.total_distributed ??
         event.amount ??
         event.revenueAmount ??
         event.revenue_amount
   );
   const distributedAt = readDate(
      event.distributedAt ??
         event.distributed_at ??
         event.timestamp ??
         event.createdAt ??
         event.ledgerClosedAt ??
         event.ledger_closed_at
   );
   const ledger = event.ledger;
   if (
      !keyId ||
      amount === null ||
      !distributedAt ||
      typeof ledger !== 'number' ||
      !Number.isInteger(ledger) ||
      typeof event.txHash !== 'string' ||
      !event.txHash
   ) {
      throw new Error(
         `RevenueDistributed event ${eventId(event)} is missing valid key, amount, date, or ledger`
      );
   }

   const chainDistributionId = readString(
      event,
      'distributionId',
      'distribution_id',
      'snapshotId',
      'snapshot_id'
   );
   const existing = await prisma.revenueDistribution.findFirst({
      where: {
         OR: [
            { ledger, txHash: event.txHash, eventIndex: event.eventIndex },
            ...(chainDistributionId ? [{ keyId, chainDistributionId }] : []),
         ],
      },
      select: { id: true },
   });
   if (existing) {
      return;
   }

   const holderRows = await prisma.keyOwnership.findMany({
      where: { creatorId: keyId, balance: { gt: 0 } },
      select: { ownerAddress: true, balance: true },
   });
   const suppliedRecipients = event.recipients ?? event.shares;
   const shares =
      Array.isArray(suppliedRecipients) && suppliedRecipients.length > 0
         ? suppliedRecipients.map((recipient: Record<string, unknown>) => {
              const wallet =
                 recipient.wallet ??
                 recipient.address ??
                 recipient.ownerAddress;
              const recipientAmount = readAmount(
                 recipient.amount ?? recipient.share
              );
              if (
                 typeof wallet !== 'string' ||
                 wallet.length === 0 ||
                 recipientAmount === null
              ) {
                 throw new Error(
                    `RevenueDistributed event ${eventId(event)} has an invalid recipient`
                 );
              }
              return { wallet, amount: recipientAmount };
           })
         : (() => {
              const totalBalance = holderRows.reduce(
                 (total, holder) => total + Number(holder.balance),
                 0
              );
              const totalAmount = Number(amount);
              return totalBalance > 0
                 ? holderRows.map(holder => ({
                      wallet: holder.ownerAddress,
                      amount: (
                         (totalAmount * Number(holder.balance)) /
                         totalBalance
                      ).toFixed(7),
                   }))
                 : [];
           })();
   const holderCountValue =
      event.holderCount ??
      event.holder_count ??
      event.holdersCount ??
      event.holders_count;
   const holderCount =
      holderCountValue === undefined || holderCountValue === null
         ? shares.length || holderRows.length
         : Number(holderCountValue);
   if (!Number.isInteger(holderCount) || holderCount < 0) {
      throw new Error(
         `RevenueDistributed event ${eventId(event)} has an invalid holder count`
      );
   }

   try {
      await prisma.$transaction(async tx => {
         const distribution = await tx.revenueDistribution.create({
            data: {
               keyId,
               chainDistributionId,
               amount,
               holderCount,
               ledger,
               txHash: event.txHash,
               eventIndex: event.eventIndex,
               distributedAt,
            },
         });
         if (shares.length > 0) {
            await tx.revenueDistributionShare.createMany({
               data: shares.map(share => ({
                  distributionId: distribution.id,
                  wallet: share.wallet,
                  amount: share.amount,
               })),
            });
         }
      });
   } catch (error) {
      if (isUniqueConstraintError(error)) {
         return;
      }
      throw error;
   }

   await cacheInvalidate(revenueDistributionCachePattern(keyId));
   logger.info(
      {
         keyId,
         distributionId: chainDistributionId,
         ledger,
         txHash: event.txHash,
      },
      'Creator revenue distribution recorded'
   );
}

async function processRevenueShareClaimedEvent(
   event: IndexerChainEvent
): Promise<void> {
   const keyId = readString(
      event,
      'keyId',
      'key_id',
      'creatorId',
      'creator_id'
   );
   const wallet = readString(
      event,
      'wallet',
      'walletAddress',
      'wallet_address',
      'claimant',
      'claimantAddress',
      'claimant_address'
   );
   const chainDistributionId = readString(
      event,
      'distributionId',
      'distribution_id',
      'snapshotId',
      'snapshot_id'
   );
   const amount = readAmount(
      event.amount ??
         event.claimedAmount ??
         event.claimed_amount ??
         event.amountXlm
   );
   const claimedAt = readDate(
      event.claimedAt ??
         event.claimed_at ??
         event.timestamp ??
         event.ledgerClosedAt ??
         event.ledger_closed_at
   );
   const ledger = event.ledger;
   if (
      !keyId ||
      !wallet ||
      amount === null ||
      Number(amount) <= 0 ||
      !claimedAt ||
      typeof ledger !== 'number' ||
      !Number.isInteger(ledger) ||
      typeof event.txHash !== 'string' ||
      !event.txHash
   ) {
      throw new Error(
         `RevenueShareClaimed event ${eventId(event)} is missing valid key, wallet, amount, date, or ledger`
      );
   }

   const existingClaim = await prisma.revenueShareClaim.findFirst({
      where: { ledger, txHash: event.txHash, eventIndex: event.eventIndex },
      select: { id: true },
   });
   if (existingClaim) {
      return;
   }

   const distributions = await prisma.revenueDistribution.findMany({
      where: {
         keyId,
         ...(chainDistributionId
            ? {
                 OR: [{ id: chainDistributionId }, { chainDistributionId }],
              }
            : { shares: { some: { wallet } } }),
      },
      orderBy: [{ distributedAt: 'asc' }, { id: 'asc' }],
      include: {
         shares: {
            where: { wallet },
            include: {
               claims: { select: { amount: true } },
            },
         },
      },
   });
   const pending = distributions
      .map(distribution => {
         const share = distribution.shares[0];
         if (!share) {
            return null;
         }
         const claimed = share.claims.reduce(
            (total, claim) => total + Number(claim.amount),
            0
         );
         const remaining = Math.max(0, Number(share.amount) - claimed);
         return { distribution, share, remaining };
      })
      .filter(
         (candidate): candidate is NonNullable<typeof candidate> =>
            candidate !== null
      )
      .filter(candidate => candidate.remaining + 0.0000001 >= Number(amount));
   const exactMatches = pending.filter(
      candidate => Math.abs(candidate.remaining - Number(amount)) < 0.0000001
   );
   const selected = chainDistributionId
      ? pending.length === 1
         ? pending[0]
         : undefined
      : exactMatches.length === 1
        ? exactMatches[0]
        : pending.length === 1
          ? pending[0]
          : undefined;
   const distribution = selected?.distribution;
   const share = selected?.share;
   if (!distribution || !share) {
      throw new Error(
         `RevenueShareClaimed event ${eventId(event)} references an unknown or ambiguous distribution or wallet share`
      );
   }

   const alreadyClaimed = share.claims.reduce(
      (total, claim) => total + Number(claim.amount),
      0
   );
   if (alreadyClaimed + Number(amount) > Number(share.amount) + 0.0000001) {
      throw new Error(
         `RevenueShareClaimed event ${eventId(event)} exceeds the wallet's distribution share`
      );
   }

   try {
      await prisma.revenueShareClaim.create({
         data: {
            distributionId: distribution.id,
            shareId: share.id,
            wallet,
            amount,
            ledger,
            txHash: event.txHash,
            eventIndex: event.eventIndex,
            claimedAt,
         },
      });
   } catch (error) {
      if (isUniqueConstraintError(error)) {
         return;
      }
      throw error;
   }

   await cacheInvalidate(revenueDistributionCachePattern(keyId));
   logger.info(
      {
         keyId,
         wallet,
         distributionId: chainDistributionId,
         ledger,
         txHash: event.txHash,
      },
      'Creator revenue share claim recorded'
   );
}

export async function processRevenueShareEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (REVENUE_DISTRIBUTION_EVENT_TYPES.has(event.eventType)) {
         await processRevenueDistributedEvent(event);
      } else if (REVENUE_CLAIM_EVENT_TYPES.has(event.eventType)) {
         await processRevenueShareClaimedEvent(event);
      }
   });
}

export interface RevenueShareContractLog {
   contractId: string;
   topics: string[];
   data?: Record<string, unknown>;
   ledger: number;
   txHash: string;
   eventIndex?: number;
   timestamp?: string | number | Date;
}

export function parseRevenueShareContractLog(
   log: RevenueShareContractLog
): IndexerChainEvent | null {
   const topic = log.topics[0]?.toLowerCase();
   if (!topic) {
      return null;
   }
   const data = log.data ?? {};
   const common = {
      keyId:
         readString(
            data as IndexerChainEvent,
            'keyId',
            'key_id',
            'creatorId',
            'creator_id'
         ) ??
         log.topics[1] ??
         log.contractId,
      ledger: log.ledger,
      txHash: log.txHash,
      eventIndex: log.eventIndex ?? 0,
   };
   if (['revenuedistributed', 'revenue_distributed'].includes(topic)) {
      return {
         eventType: 'RevenueDistributed',
         ...common,
         distributionId:
            data.distributionId ?? data.distribution_id ?? log.topics[2],
         amount:
            data.amount ??
            data.totalAmount ??
            data.total_amount ??
            data.totalDistributed ??
            data.total_distributed ??
            log.topics[3],
         holderCount:
            data.holderCount ??
            data.holder_count ??
            data.holdersCount ??
            data.holders_count ??
            log.topics[4],
         distributedAt:
            data.distributedAt ??
            data.distributed_at ??
            data.timestamp ??
            data.ledgerClosedAt ??
            data.ledger_closed_at ??
            log.timestamp,
         recipients: data.recipients ?? data.shares,
      };
   }
   if (['revenueshareclaimed', 'revenue_share_claimed'].includes(topic)) {
      return {
         eventType: 'RevenueShareClaimed',
         ...common,
         wallet:
            data.wallet ??
            data.walletAddress ??
            data.wallet_address ??
            data.claimant ??
            data.claimantAddress ??
            data.claimant_address ??
            log.topics[2],
         amount:
            data.amount ??
            data.claimedAmount ??
            data.claimed_amount ??
            data.amountXlm ??
            log.topics[3],
         distributionId:
            data.distributionId ??
            data.distribution_id ??
            data.snapshotId ??
            data.snapshot_id ??
            log.topics[4],
         claimedAt:
            data.claimedAt ??
            data.claimed_at ??
            data.timestamp ??
            data.ledgerClosedAt ??
            data.ledger_closed_at ??
            log.timestamp,
      };
   }
   return null;
}
