import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { protocolRevenueCachePattern } from '../revenue/protocol-revenue.service';
import { cacheInvalidate } from '../../utils/redis.utils';

/**
 * Chain event for the protocol_revenue_distributed contract event (#875).
 */
export interface ProtocolRevenueDistributedEvent extends IndexerChainEvent {
   eventType: 'PROTOCOL_REVENUE_DISTRIBUTED';
   distributionId: string;
   totalDistributed: string;
   stakerCount: number;
   snapshotId: string;
   distributedAt: string; // ISO timestamp
   recipients: Array<{ wallet: string; amount: string }>;
}

/**
 * Processes a batch of PROTOCOL_REVENUE_DISTRIBUTED events, storing one
 * ProtocolRevenueDistribution per event with a share row per recipient.
 * Already-recorded distributions are skipped so replays are idempotent.
 */
export async function processProtocolRevenueEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (event.eventType !== 'PROTOCOL_REVENUE_DISTRIBUTED') {
         return;
      }

      const typedEvent = event as ProtocolRevenueDistributedEvent;
      const requiredFields = [
         'distributionId',
         'totalDistributed',
         'stakerCount',
         'snapshotId',
         'distributedAt',
         'recipients',
         'ledger',
      ];
      for (const field of requiredFields) {
         const value = typedEvent[field as keyof ProtocolRevenueDistributedEvent];
         if (value === undefined || value === null || value === '') {
            logger.warn(
               {
                  eventId: `${event.txHash}:${event.eventIndex}`,
                  missingField: field,
               },
               'Skipping protocol revenue event due to missing required field'
            );
            return;
         }
      }

      const existing = await prisma.protocolRevenueDistribution.findUnique({
         where: { distributionId: typedEvent.distributionId },
         select: { id: true },
      });
      if (existing) {
         return;
      }

      await prisma.protocolRevenueDistribution.create({
         data: {
            distributionId: typedEvent.distributionId,
            totalDistributed: typedEvent.totalDistributed,
            stakerCount: typedEvent.stakerCount,
            snapshotId: typedEvent.snapshotId,
            ledger: Number(typedEvent.ledger),
            txHash: String(typedEvent.txHash),
            distributedAt: new Date(typedEvent.distributedAt),
            shares: {
               create: typedEvent.recipients.map(recipient => ({
                  wallet: recipient.wallet,
                  amount: recipient.amount,
               })),
            },
         },
      });

      await cacheInvalidate(
         ...typedEvent.recipients.map(r => protocolRevenueCachePattern(r.wallet))
      );

      logger.info(
         {
            distributionId: typedEvent.distributionId,
            stakerCount: typedEvent.stakerCount,
            ledger: Number(typedEvent.ledger),
            txHash: String(typedEvent.txHash),
         },
         'Protocol revenue distribution recorded'
      );
   });
}
