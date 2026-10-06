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
   eventType: 'DIVIDEND_DISTRIBUTED';
   creatorId: string;
   totalAmountXlm: string; // In stroops or XLM, as string for precision
   holdersCount: number;
   distributorAddress: string;
   distributedAt: string; // ISO timestamp
}

/**
 * Extended chain event interface for dividend claim events.
 */
export interface DividendClaimedEvent extends IndexerChainEvent {
   eventType: 'DIVIDEND_CLAIMED';
   creatorId: string;
   claimantAddress: string;
   amountXlm: string | number;
   distributionId?: string;
   claimedAt: string; // ISO timestamp
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
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      // Validate event type
      if (
         event.eventType !== 'DIVIDEND_DISTRIBUTED' &&
         event.eventType !== 'DIVIDEND_CLAIMED'
      ) {
         return;
      }

      if (event.eventType === 'DIVIDEND_CLAIMED') {
         const typedEvent = event as DividendClaimedEvent;
         const requiredFields = [
            'creatorId',
            'claimantAddress',
            'amountXlm',
            'claimedAt',
            'ledger',
            'txHash',
         ];

         for (const field of requiredFields) {
            if (
               typedEvent[field as keyof DividendClaimedEvent] === undefined ||
               typedEvent[field as keyof DividendClaimedEvent] === null ||
               typedEvent[field as keyof DividendClaimedEvent] === ''
            ) {
               logger.warn(
                  {
                     eventId: `${event.txHash}:${event.eventIndex}`,
                     missingField: field,
                  },
                  'Skipping dividend claim event due to missing required field'
               );
               return;
            }
         }

         const {
            creatorId,
            claimantAddress,
            amountXlm,
            distributionId,
            claimedAt,
            ledger,
            txHash,
         } = typedEvent;

         const claimedDate = new Date(claimedAt);

         // 1. Mark pending claim(s) as claimed
         if (distributionId) {
            await prisma.dividendClaim.updateMany({
               where: {
                  distributionId,
                  recipientAddress: claimantAddress,
               },
               data: {
                  claimedAt: claimedDate,
               },
            });
         } else {
            await prisma.dividendClaim.updateMany({
               where: {
                  recipientAddress: claimantAddress,
                  distribution: { creatorId },
                  claimedAt: null,
               },
               data: {
                  claimedAt: claimedDate,
               },
            });
         }

         // 2. Create Activity record
         await prisma.activity.create({
            data: {
               type: 'DIVIDEND_CLAIMED' as any,
               actor: claimantAddress,
               creatorId,
               payload: {
                  amount_xlm: String(amountXlm),
                  claimant: claimantAddress,
                  distribution_id: distributionId || null,
                  ledger_sequence: Number(ledger),
                  tx_hash: String(txHash),
               },
               createdAt: claimedDate,
            },
         });

         // 3. Invalidate dividend cache
         try {
            const { invalidateDividendCache } = await import(
               '../dividends/dividend.service'
            );
            await invalidateDividendCache(creatorId, claimantAddress);
         } catch {
            // Non-critical cache invalidation failure
         }

         logger.info(
            {
               creatorId,
               claimantAddress,
               amountXlm,
               distributionId,
               ledger: Number(ledger),
               txHash: String(txHash),
            },
            'Dividend claim event processed'
         );
         return;
      }

      // Type guard and required field validation
      const typedEvent = event as DividendDistributedEvent;
      const requiredFields = [
         'creatorId',
         'totalAmountXlm',
         'holdersCount',
         'distributorAddress',
         'distributedAt',
         'ledger',
      ];

      for (const field of requiredFields) {
         if (
            typedEvent[field as keyof DividendDistributedEvent] === undefined ||
            typedEvent[field as keyof DividendDistributedEvent] === null ||
            typedEvent[field as keyof DividendDistributedEvent] === ''
         ) {
            logger.warn(
               {
                  eventId: `${event.txHash}:${event.eventIndex}`,
                  missingField: field,
               },
               'Skipping dividend event due to missing required field'
            );
            return;
         }
      }

      const {
         creatorId,
         totalAmountXlm,
         holdersCount,
         distributorAddress,
         distributedAt,
         ledger,
         txHash,
      } = typedEvent;

      // Calculate per-key amount
      let perKeyAmountXlm = '0';
      if (holdersCount > 0) {
         // Handle both decimal and integer inputs
         const totalAsDecimal =
            typeof totalAmountXlm === 'string'
               ? parseFloat(totalAmountXlm)
               : Number(totalAmountXlm);
         const perKeyAmount = totalAsDecimal / holdersCount;
         perKeyAmountXlm = perKeyAmount.toFixed(7); // 7 decimal places for Decimal(20,7)
      }

      // 1. Create DividendDistribution record
      const distribution = await prisma.dividendDistribution.create({
         data: {
            creatorId,
            distributionDate: new Date(distributedAt),
            totalAmountXlm: parseFloat(totalAmountXlm),
            holderCount: holdersCount,
            perKeyAmountXlm: parseFloat(perKeyAmountXlm),
            ledger: Number(ledger),
            txHash: String(txHash),
         },
      });

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

      // 3. Create DividendClaim records for each holder
      if (holders.length > 0) {
         const claims = holders.map(holder => {
            // Calculate holder's payout: perKeyAmount * holderBalance
            const holderBalance =
               typeof holder.balance === 'string'
                  ? parseFloat(holder.balance)
                  : Number(holder.balance);
            const holderPayout = (
               parseFloat(perKeyAmountXlm) * holderBalance
            ).toFixed(7);

            return {
               distributionId: distribution.id,
               recipientAddress: holder.ownerAddress,
               amountXlm: parseFloat(holderPayout),
            };
         });

         await prisma.dividendClaim.createMany({
            data: claims,
            skipDuplicates: true,
         });
      }

      // 4. Create Activity record for audit trail
      await prisma.activity.create({
         data: {
            type: 'DIVIDEND_DISTRIBUTED',
            actor: distributorAddress,
            creatorId,
            payload: {
               total_amount_xlm: totalAmountXlm,
               per_key_amount_xlm: perKeyAmountXlm,
               holders_count: holdersCount,
               distribution_id: distribution.id,
               ledger_sequence: Number(ledger),
            },
            createdAt: new Date(distributedAt),
         },
      });

      // Invalidate the platform activity feed's cached first page (#936) so
      // this new DIVIDEND_DISTRIBUTED ("settlement") activity shows up promptly.
      const { invalidateActivityFeedCache } =
         await import('../activity/activity-feed.service');
      await invalidateActivityFeedCache();

      logger.info(
         {
            distributionId: distribution.id,
            creatorId,
            totalAmountXlm,
            holderCount: holdersCount,
            perKeyAmountXlm,
            ledger: Number(ledger),
            txHash: String(txHash),
         },
         'Dividend distribution processed'
      );

      try {
         const { invalidateCreatorDashboardCache } =
            await import('../creator/creator-dashboard.service');
         await invalidateCreatorDashboardCache(creatorId);
      } catch {
         // Non-critical cache invalidation failure
      }

      try {
         const { invalidateDividendCache } = await import(
            '../dividends/dividend.service'
         );
         await invalidateDividendCache(creatorId);
      } catch {
         // Non-critical cache invalidation failure
      }
   });

   // Update checkpoint with highest ledger processed
   const uniqueEvents = dedupeChainEvents(events);
   const processedLedgers = uniqueEvents
      .map(e => e.ledger)
      .filter((l): l is number => typeof l === 'number');

   if (processedLedgers.length > 0) {
      const maxLedger = Math.max(...processedLedgers);
      // Compute batch hash for deduplication detection
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
   const timestamp = log.timestamp
      ? new Date(log.timestamp).toISOString()
      : new Date().toISOString();

   if (
      topic0 === 'dividend_distributed' ||
      topic0 === 'dividenddistributed' ||
      topic0 === 'distributed'
   ) {
      const creatorId = log.topics[1] || log.data?.creatorId || log.contractId;
      const totalAmountXlm = String(
         log.data?.totalAmountXlm || log.data?.totalAmount || log.topics[2] || '0'
      );
      const holdersCount = Number(
         log.data?.holdersCount || log.data?.holderCount || log.topics[3] || 0
      );
      const distributorAddress = String(
         log.data?.distributorAddress ||
            log.data?.distributor ||
            log.topics[4] ||
            ''
      );

      return {
         eventType: 'DIVIDEND_DISTRIBUTED',
         creatorId,
         totalAmountXlm,
         holdersCount,
         distributorAddress,
         distributedAt: timestamp,
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
      const creatorId = log.topics[1] || log.data?.creatorId || log.contractId;
      const claimantAddress = String(
         log.topics[2] || log.data?.claimantAddress || log.data?.claimant || ''
      );
      const amountXlm = String(
         log.data?.amountXlm || log.data?.amount || log.topics[3] || '0'
      );
      const distributionId =
         log.data?.distributionId || log.topics[4] || undefined;

      return {
         eventType: 'DIVIDEND_CLAIMED',
         creatorId,
         claimantAddress,
         amountXlm,
         distributionId,
         claimedAt: timestamp,
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
