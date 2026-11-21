import { Decimal } from '@prisma/client/runtime/library';
import { IndexerChainEvent } from '../../types/indexer.types';
import { recordBuybackContribution } from './buyback-pool.service';
import { logger } from '../../utils/logger.utils';

/**
 * Interface for SellTaxCollected contract event
 */
export interface SellTaxCollectedEvent extends IndexerChainEvent {
   eventType: 'SELL_TAX_COLLECTED';
   creatorId: string;
   amountXlm: string;
   ledger: number;
   txHash: string;
   eventIndex: number;
}

/**
 * Process SellTaxCollected events and update buyback pool balances.
 * Called by the indexer pipeline when new sell tax events are received.
 */
export async function processSellTaxCollectedEvents(
   events: SellTaxCollectedEvent[]
): Promise<void> {
   if (events.length === 0) {
      return;
   }

   for (const event of events) {
      try {
         const amountXlm = new Decimal(event.amountXlm);

         // Record contribution to buyback pool
         await recordBuybackContribution(
            event.creatorId,
            amountXlm,
            event.ledger,
            event.txHash,
            event.eventIndex
         );

         logger.info(
            {
               eventType: event.eventType,
               creatorId: event.creatorId,
               amountXlm: event.amountXlm,
               ledger: event.ledger,
               txHash: event.txHash,
            },
            'Sell tax collected event processed'
         );
      } catch (error) {
         logger.error(
            {
               error,
               event,
            },
            'Failed to process SellTaxCollected event'
         );
         throw error;
      }
   }
}
