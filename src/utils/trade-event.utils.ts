import { logger } from './logger.utils';
import { dispatchWebhookEvent } from '../modules/webhooks';
import type { TradeEvent } from '../modules/webhooks';
import { evaluateTradeForAlerts } from '../modules/alerts';

/**
 * Single entry point for processing a creator-key trade event off the indexer.
 *
 * Fans out the trade event to every interested consumer:
 *  - trade webhooks registered by the creator (buy/sell notifications)
 *  - price-threshold alerts registered by fans (one-shot price-cross alerts)
 *
 * Each consumer is isolated: a failure in one does not prevent the other from
 * running, so a webhook delivery problem never suppresses a price alert (and
 * vice-versa).
 */
export async function processTradeEvent(tradeEvent: TradeEvent): Promise<void> {
  const results = await Promise.allSettled([
    dispatchWebhookEvent(tradeEvent),
    evaluateTradeForAlerts({
      creatorId: tradeEvent.creatorId,
      price: tradeEvent.price,
      timestamp: tradeEvent.timestamp,
    }),
  ]);

  for (const result of results) {
    if (result.status === 'rejected') {
      logger.error(
        {
          creatorId: tradeEvent.creatorId,
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        },
        'Trade-event consumer failed'
      );
    }
  }
}
