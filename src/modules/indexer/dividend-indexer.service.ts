import { prisma } from '../../utils/prisma.utils';
import { updateIndexedLedger } from './ledger-gap-detection.service';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { dedupeChainEvents } from '../../utils/indexer-dedupe.utils';

/**
 * Extended chain event interface for dividend distribution events.
 */
export interface DividendDistributedEvent extends IndexerChainEvent {
   eventType:
      | 'DIVIDEND_DISTRIBUTED'
      | 'DIVIDEND_SNAPSHOT_CREATED'
      | 'DividendSnapshotCreated';
   creatorId?: string;
   keyId?: string;
   totalAmountXlm?: string;
   totalDistributed?: string | number;
   holdersCount?: number;
   holderCount?: number;
   distributorAddress?: string;
   distributedAt?: string;
   claimWindowStart?: string;
   claimWindowEnd?: string;
   snapshotId?: string;
}

/**
 * Extended chain event interface for dividend claim events.
 */
export interface DividendClaimedEvent extends IndexerChainEvent {
   eventType: 'DIVIDEND_CLAIMED' | 'DividendClaimed';
   creatorId?: string;
   keyId?: string;
   claimantAddress?: string;
   wallet?: string;
   amountXlm?: string | number;
   distributionId?: string;
   snapshotId?: string;
   claimedAt?: string;
}

function parseEventDate(value: unknown): Date | null {
   let date: Date;
   if (value instanceof Date) {
      date = new Date(value.getTime());
   } else if (typeof value === 'number') {
      date = new Date(value < 100_000_000_000 ? value * 1000 : value);
   } else if (typeof value === 'string' && value.trim() !== '') {
      date = new Date(value);
   } else {
      return null;
   }
   return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Processes a batch of dividend distribution events (DIVIDEND_DISTRIBUTED).
 *
 * - Deduplicates the events based on txHash and eventIndex.
 * - Parses and validates each event.
 * - Creates a DividendDistribution record with calculated perKeyAmount.
 * - Creates DividendClaim records for all current key holders at distribution time.
 * - Creates an Activity record for audit trail.
 * - Writes a checkpoint record of the highest ledger processed.
 */
export async function processDividendEvents(
   events: IndexerChainEvent[],
   options: { advanceCursor?: boolean } = {}
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      const isClaimEvent = ['DIVIDEND_CLAIMED', 'DividendClaimed'].includes(
         event.eventType
      );
      const isSnapshotEvent = [
         'DIVIDEND_DISTRIBUTED',
         'DIVIDEND_SNAPSHOT_CREATED',
         'DividendSnapshotCreated',
      ].includes(event.eventType);
      if (!isClaimEvent && !isSnapshotEvent) {
         return;
      }

      if (isClaimEvent) {
         const typedEvent = event as DividendClaimedEvent;
         const creatorId =
            typedEvent.creatorId || typedEvent.keyId || typedEvent.key_id;
         const claimantAddress =
            typedEvent.claimantAddress ||
            typedEvent.claimant_address ||
            typedEvent.wallet ||
            typedEvent.wallet_address;
         const amountXlm =
            typedEvent.amountXlm ??
            typedEvent.amount_xlm ??
            typedEvent.claimedAmount;
         const claimedAt =
            typedEvent.claimedAt || typedEvent.claimed_at || typedEvent.timestamp;
         const snapshotReference =
            typedEvent.distributionId ||
            typedEvent.distribution_id ||
            typedEvent.snapshotId ||
            typedEvent.snapshot_id;
         if (
            !creatorId ||
            !claimantAddress ||
            !claimedAt ||
            typeof event.ledger !== 'number' ||
            !event.txHash
         ) {
            logger.warn(
               { eventId: `${event.txHash}:${event.eventIndex}` },
               'Skipping dividend claim event due to missing required fields'
            );
            return;
         }

         const claimedDate = parseEventDate(claimedAt);
         const amount =
            amountXlm === undefined || amountXlm === null
               ? undefined
               : Number(amountXlm);
         if (
            (amount !== undefined && !Number.isFinite(amount)) ||
            !claimedDate
         ) {
            logger.warn(
               { eventId: `${event.txHash}:${event.eventIndex}` },
               'Skipping dividend claim event due to invalid amount or date'
            );
            return;
         }

         const claimDate = claimedDate;
         const claimWasMarked = await prisma.$transaction(async tx => {
            const distribution = snapshotReference
               ? await tx.dividendDistribution.findFirst({
                    where: {
                       creatorId,
                       OR: [
                          { id: snapshotReference },
                          { chainSnapshotId: snapshotReference },
                       ],
                    },
                    select: { id: true },
                 })
               : null;
            if (snapshotReference && !distribution) {
               logger.warn(
                  {
                     eventId: `${event.txHash}:${event.eventIndex}`,
                     creatorId,
                     snapshotReference,
                  },
                  'Dividend claim references an unknown snapshot'
               );
               return false;
            }
            const pendingClaims = await tx.dividendClaim.findMany({
               where: {
                  recipientAddress: claimantAddress,
                  claimedAt: null,
                  distribution: {
                     creatorId,
                     ...(distribution ? { id: distribution.id } : {}),
                  },
               },
               orderBy: [
                  { distribution: { distributionDate: 'asc' } },
                  { id: 'asc' },
               ],
               select: { id: true, amountXlm: true, distributionId: true },
            });

            const matchingClaims = pendingClaims.filter(
               claim =>
                  amount === undefined || Number(claim.amountXlm) === amount
            );
            if (!snapshotReference && matchingClaims.length !== 1) {
               logger.warn(
                  {
                     eventId: `${event.txHash}:${event.eventIndex}`,
                     creatorId,
                     claimantAddress,
                     matchingClaimCount: matchingClaims.length,
                     amountXlm: amount,
                  },
                  'Dividend claim without a snapshot reference is ambiguous'
               );
               return false;
            }
            const matchingClaim = matchingClaims[0];
            if (!matchingClaim) {
               logger.warn(
                  {
                     eventId: `${event.txHash}:${event.eventIndex}`,
                     creatorId,
                     claimantAddress,
                     snapshotReference,
                     amountXlm: amount ?? null,
                  },
                  'No matching pending dividend claim found for claim event'
               );
               return false;
            }

            const claimUpdate = await tx.dividendClaim.updateMany({
               where: { id: matchingClaim.id, claimedAt: null },
               data: { claimedAt: claimDate },
            });
            if (claimUpdate.count === 0) {
               return false;
            }

            await tx.activity.create({
               data: {
                  type: 'DIVIDEND_CLAIMED',
                  actor: claimantAddress,
                  creatorId,
                  payload: {
                     amount_xlm: String(matchingClaim.amountXlm),
                     claimant: claimantAddress,
                     distribution_id: matchingClaim.distributionId,
                     ledger_sequence: event.ledger,
                     tx_hash: event.txHash,
                  },
                  createdAt: claimDate,
               },
            });
            return true;
         });
         if (!claimWasMarked) {
            return;
         }

         try {
            const { invalidateDividendCache } = await import(
               '../dividends/dividend.service'
            );
            await invalidateDividendCache(creatorId, claimantAddress);
         } catch (error) {
            logger.warn(
               { error, creatorId, claimantAddress },
               'Failed to invalidate dividend cache after claim'
            );
         }

         logger.info(
            {
               creatorId,
               claimantAddress,
               amountXlm: amount ?? null,
               distributionId: snapshotReference,
               ledger: event.ledger,
               txHash: event.txHash,
            },
            'Dividend claim event processed'
         );
         return;
      }

      // Type guard and required field validation
      const typedEvent = event as DividendDistributedEvent;
      const creatorId =
         typedEvent.creatorId || typedEvent.keyId || typedEvent.key_id;
      const totalAmountXlm =
         typedEvent.totalDistributed ??
         typedEvent.total_distributed ??
         typedEvent.totalAmountXlm ??
         typedEvent.total_amount_xlm;
      const distributedAt =
         typedEvent.distributedAt ||
         typedEvent.distributed_at ||
         typedEvent.createdAt ||
         typedEvent.timestamp;
      const holdersCount =
         typedEvent.holdersCount ??
         typedEvent.holderCount ??
         typedEvent.holders_count;
      const distributorAddress =
         typedEvent.distributorAddress ||
         typedEvent.distributor_address ||
         typedEvent.distributor ||
         'unknown';
      const ledger = event.ledger;
      const txHash = event.txHash;
      const distributionDate = parseEventDate(distributedAt);
      if (
         !creatorId ||
         totalAmountXlm === undefined ||
         typeof ledger !== 'number' ||
         !txHash ||
         !distributionDate
      ) {
         logger.warn(
            { eventId: `${event.txHash}:${event.eventIndex}` },
            'Skipping dividend snapshot event due to missing required fields'
         );
         return;
      }

      let perKeyAmountXlm = '0';
      const totalAsDecimal = Number(totalAmountXlm);
      if (!Number.isFinite(totalAsDecimal) || totalAsDecimal < 0) {
         logger.warn(
            { eventId: `${event.txHash}:${event.eventIndex}`, totalAmountXlm },
            'Skipping dividend snapshot event due to invalid total'
         );
         return;
      }
      // 1. Create DividendDistribution record
      const rawClaimWindowStart =
         typedEvent.claimWindowStart ??
         typedEvent.claim_window_start ??
         typedEvent.claimStart;
      const rawClaimWindowEnd =
         typedEvent.claimWindowEnd ??
         typedEvent.claim_window_end ??
         typedEvent.claimEnd;
      const claimWindowStart = rawClaimWindowStart
         ? parseEventDate(rawClaimWindowStart)
         : null;
      const claimWindowEnd = rawClaimWindowEnd
         ? parseEventDate(rawClaimWindowEnd)
         : null;
      if (
         (rawClaimWindowStart && !claimWindowStart) ||
         (rawClaimWindowEnd && !claimWindowEnd)
      ) {
         logger.warn(
            { eventId: `${event.txHash}:${event.eventIndex}` },
            'Skipping dividend snapshot event due to invalid timestamp'
         );
         return;
      }

      // 2. Get all current key holders for this creator (balance > 0)
      const holders = await prisma.keyOwnership.findMany({
         where: {
            creatorId,
            balance: { gt: 0 },
         },
         select: {
            id: true,
            ownerAddress: true,
            balance: true,
         },
      });
      const effectiveHolderCount = holdersCount ?? holders.length;
      const totalKeyBalance = holders.reduce(
         (total, holder) => total + Number(holder.balance),
         0
      );
      const allocationDenominator =
         event.eventType === 'DIVIDEND_SNAPSHOT_CREATED' ||
         event.eventType === 'DividendSnapshotCreated'
            ? totalKeyBalance
            : effectiveHolderCount;
      if (allocationDenominator > 0) {
         perKeyAmountXlm = (totalAsDecimal / allocationDenominator).toFixed(7);
      }

      let distribution;
      try {
         distribution = await prisma.$transaction(async tx => {
            const createdDistribution =
               await tx.dividendDistribution.create({
                  data: {
                     creatorId,
                     distributionDate,
                     totalAmountXlm: totalAsDecimal,
                     holderCount: effectiveHolderCount,
                     perKeyAmountXlm: parseFloat(perKeyAmountXlm),
                     claimWindowStart,
                     claimWindowEnd,
                     chainSnapshotId:
                        typedEvent.snapshotId ??
                        typedEvent.snapshot_id ??
                        null,
                     ledger,
                     txHash,
                     eventIndex: event.eventIndex,
                  },
               });

            if (holders.length > 0) {
               const claims = holders.map(holder => {
                  const holderBalance = Number(holder.balance);
                  const holderPayout = (
                     parseFloat(perKeyAmountXlm) * holderBalance
                  ).toFixed(7);

                  return {
                     distributionId: createdDistribution.id,
                     recipientAddress: holder.ownerAddress,
                     amountXlm: parseFloat(holderPayout),
                  };
               });
               await tx.dividendClaim.createMany({
                  data: claims,
                  skipDuplicates: true,
               });
            }

            await tx.activity.create({
               data: {
                  type: 'DIVIDEND_DISTRIBUTED',
                  actor: distributorAddress,
                  creatorId,
                  payload: {
                     total_amount_xlm: String(totalAsDecimal),
                     per_key_amount_xlm: perKeyAmountXlm,
                     holders_count: effectiveHolderCount,
                     distribution_id: createdDistribution.id,
                     ledger_sequence: ledger,
                  },
                  createdAt: distributionDate,
               },
            });
            return createdDistribution;
         });
      } catch (error) {
         if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'P2002'
         ) {
            logger.info(
               { eventId: `${txHash}:${event.eventIndex}` },
               'Duplicate dividend snapshot event skipped'
            );
            return;
         }
         throw error;
      }

      // Invalidate the platform activity feed's cached first page (#936) so
      // this new DIVIDEND_DISTRIBUTED ("settlement") activity shows up promptly.
      try {
         const { invalidateActivityFeedCache } =
            await import('../activity/activity-feed.service');
         await invalidateActivityFeedCache();
      } catch (error) {
         logger.warn(
            { error, creatorId },
            'Failed to invalidate activity feed after dividend snapshot'
         );
      }

      logger.info(
         {
            distributionId: distribution.id,
            creatorId,
            totalAmountXlm,
            holderCount: effectiveHolderCount,
            perKeyAmountXlm,
            ledger,
            txHash,
         },
         'Dividend distribution processed'
      );

      try {
         const { invalidateCreatorDashboardCache } =
            await import('../creator/creator-dashboard.service');
         await invalidateCreatorDashboardCache(creatorId);
      } catch (error) {
         logger.warn(
            { error, creatorId },
            'Failed to invalidate creator dashboard after dividend snapshot'
         );
      }

      try {
         const { invalidateDividendCache } = await import(
            '../dividends/dividend.service'
         );
         await invalidateDividendCache(creatorId);
      } catch (error) {
         logger.warn(
            { error, creatorId },
            'Failed to invalidate dividend cache after snapshot'
         );
      }
   });

   if (options.advanceCursor !== false) {
      // Update checkpoint with highest ledger processed.
      const uniqueEvents = dedupeChainEvents(events);
      const processedLedgers = uniqueEvents
         .map(e => e.ledger)
         .filter((l): l is number => typeof l === 'number');

      if (processedLedgers.length > 0) {
         const maxLedger = Math.max(...processedLedgers);
         const identifiers = uniqueEvents
            .map(e => `${e.txHash}:${e.eventIndex}`)
            .sort()
            .join('|');
         const { createHash } = await import('crypto');
         const batchHash = createHash('sha256')
            .update(identifiers, 'utf8')
            .digest('hex')
            .slice(0, 16);
         const cursor = `${maxLedger}-000`;
         await updateIndexedLedger(maxLedger, cursor, batchHash);
      }
   }
}

/**
 * Raw contract log shape from Soroban RPC or Horizon.
 */
export interface DividendContractLog {
   contractId: string;
   topics: string[];
   data?: any;
   ledger: number;
   txHash: string;
   timestamp?: string | number | Date;
   eventIndex?: number;
}

/**
 * Parses raw Soroban contract logs into typed IndexerChainEvents.
 */
export function parseDividendContractLog(
   log: DividendContractLog
): DividendDistributedEvent | DividendClaimedEvent | null {
   if (!log.topics || log.topics.length === 0) {
      return null;
   }

   const topic0 = String(log.topics[0]).toLowerCase();
   const timestamp =
      parseEventDate(log.timestamp)?.toISOString() ?? new Date().toISOString();
   const isSnapshotCreatedTopic =
      topic0 === 'dividendsnapshotcreated' ||
      topic0 === 'dividend_snapshot_created';

   if (
      isSnapshotCreatedTopic ||
      topic0 === 'dividend_distributed' ||
      topic0 === 'dividenddistributed' ||
      topic0 === 'distributed'
   ) {
      const creatorId =
         log.data?.creatorId ||
         log.data?.keyId ||
         log.data?.key_id ||
         log.topics[1] ||
         log.contractId;
      const totalAmountXlm = String(
         log.data?.totalDistributed ??
            log.data?.total_distributed ??
            log.data?.totalAmountXlm ??
            log.data?.total_amount_xlm ??
            log.data?.totalAmount ??
            log.topics[2] ??
            '0'
      );
      const holdersCount = Number(
         log.data?.holdersCount ??
            log.data?.holders_count ??
            log.data?.holderCount ??
            log.data?.holder_count ??
            log.topics[3] ??
            0
      );
      const distributorAddress = String(
         log.data?.distributorAddress ||
            log.data?.distributor_address ||
            log.data?.distributor ||
            (isSnapshotCreatedTopic ? '' : log.topics[4]) ||
            ''
      );

      return {
         eventType:
            topic0 === 'dividendsnapshotcreated' ||
            topic0 === 'dividend_snapshot_created'
               ? 'DIVIDEND_SNAPSHOT_CREATED'
               : 'DIVIDEND_DISTRIBUTED',
         creatorId,
         totalAmountXlm,
         totalDistributed: totalAmountXlm,
         holdersCount,
         distributorAddress,
         distributedAt:
            log.data?.distributedAt ||
            log.data?.distributed_at ||
            log.data?.createdAt ||
            log.data?.timestamp ||
            timestamp,
         claimWindowStart:
            log.data?.claimWindowStart ||
            log.data?.claim_window_start ||
            log.data?.claimStart ||
            undefined,
         claimWindowEnd:
            log.data?.claimWindowEnd ||
            log.data?.claim_window_end ||
            log.data?.claimEnd ||
            undefined,
         snapshotId:
            log.data?.snapshotId ||
            log.data?.snapshot_id ||
            (isSnapshotCreatedTopic ? log.topics[4] : undefined),
         ledger: log.ledger,
         txHash: log.txHash,
         eventIndex: log.eventIndex ?? 0,
      };
   }

   if (
      topic0 === 'dividend_claimed' ||
      topic0 === 'dividendclaimed' ||
      topic0 === 'claimed'
   ) {
      const creatorId =
         log.data?.creatorId ||
         log.data?.keyId ||
            log.data?.key_id ||
            log.topics[1] ||
            log.contractId;
      const claimantAddress = String(
            log.data?.claimantAddress ||
               log.data?.claimant_address ||
               log.data?.claimant ||
               log.data?.wallet ||
               log.data?.walletAddress ||
               log.data?.wallet_address ||
               log.topics[2] ||
               ''
      );
      const rawAmount =
            log.data?.amountXlm ??
            log.data?.amount_xlm ??
            log.data?.amount ??
            log.data?.claimedAmount ??
            log.data?.claimed_amount ??
            log.topics[3] ??
            undefined;
      const amountXlm =
            rawAmount === undefined ? undefined : String(rawAmount);
      const distributionId =
         log.data?.distributionId ||
         log.data?.distribution_id ||
         log.data?.snapshotId ||
         log.data?.snapshot_id ||
         log.topics[4] ||
         undefined;

      return {
         eventType:
            topic0 === 'dividendclaimed'
               ? 'DividendClaimed'
               : 'DIVIDEND_CLAIMED',
         creatorId,
         claimantAddress,
         amountXlm,
         distributionId,
         snapshotId: distributionId,
         claimedAt:
            log.data?.claimedAt ||
            log.data?.claimed_at ||
            log.data?.timestamp ||
            timestamp,
         ledger: log.ledger,
         txHash: log.txHash,
         eventIndex: log.eventIndex ?? 0,
      };
   }

   return null;
}

/**
 * Indexes dividend events directly from contract logs.
 */
export async function processDividendContractLogs(
   logs: DividendContractLog[]
): Promise<void> {
   const events: IndexerChainEvent[] = [];
   for (const log of logs) {
      const parsed = parseDividendContractLog(log);
      if (parsed) {
         events.push(parsed);
      }
   }
   if (events.length > 0) {
      await processDividendEvents(events);
   }
}
