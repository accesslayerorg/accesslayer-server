import { invalidateFeeTierCache, recordTierTransition, getCurrentFeeTier } from './fee-tier.service';
import { logger } from '../../utils/logger.utils';

/**
 * Interface for trade indexer events (KEY_BOUGHT, KEY_SOLD)
 */
export interface TradeEvent {
   eventType: 'KEY_BOUGHT' | 'KEY_SOLD';
   creatorId: string;
   buyerAddress: string;
   quantity: number;
   price: string; // In stroops
   ledger: number;
   txHash: string;
}

let previousTierLabel: string | null = null;

/**
 * Process trade events and invalidate fee tier cache.
 * Called by the indexer pipeline when new trades are recorded.
 * Also detects tier transitions and records them in audit logs.
 */
export async function processTradeEventsForFeeTier(
   events: TradeEvent[]
): Promise<void> {
   if (events.length === 0) {
      return;
   }

   try {
      // Invalidate fee tier cache on any new trade
      await invalidateFeeTierCache();

      // Check if we're transitioning to a new tier
      try {
         const currentFee = await getCurrentFeeTier();
         
         // Initialize previous tier on first call
         if (previousTierLabel === null) {
            previousTierLabel = currentFee.tierLabel;
         }

         // Detect tier transition
         if (currentFee.tierLabel !== previousTierLabel) {
            const previousTier = previousTierLabel || 'UNKNOWN';
            previousTierLabel = currentFee.tierLabel;

            await recordTierTransition(
               previousTier,
               currentFee.tierLabel,
               currentFee.volume24hStroops
            );

            logger.info(
               {
                  previousTier,
                  newTier: currentFee.tierLabel,
                  volume24hStroops: currentFee.volume24hStroops,
               },
               'Fee tier transition detected'
            );
         }
      } catch (tierCheckError) {
         logger.warn(
            { error: tierCheckError },
            'Failed to check for tier transition'
         );
         // Don't throw - cache invalidation is the critical part
      }
   } catch (error) {
      logger.error(
         { error, eventCount: events.length },
         'Failed to process fee tier updates for trades'
      );
      // Don't throw - this should not block trade processing
   }
}
