import { logger } from '../../utils/logger.utils';
import { buildLogFields } from '../../utils/log-fields.utils';

export interface SorobanBuyEvent {
   buyer: string;
   creator_id: string;
   quantity: string;
   price: string;
   ledger: number;
   tx_hash: string;
   timestamp: string;
}

const REQUIRED_FIELDS: (keyof SorobanBuyEvent)[] = [
   'buyer',
   'creator_id',
   'quantity',
   'price',
   'ledger',
   'tx_hash',
   'timestamp',
];

function validateEvent(
   event: Partial<SorobanBuyEvent>
): event is SorobanBuyEvent {
   for (const field of REQUIRED_FIELDS) {
      const value = event[field];
      if (value === undefined || value === null || value === '') {
         return false;
      }
   }

   if (typeof event.ledger !== 'number' || isNaN(event.ledger)) {
      return false;
   }

   return true;
}

export async function processTradeEvent(
   event: Partial<SorobanBuyEvent>,
   db: any
): Promise<boolean> {
   if (!validateEvent(event)) {
      const missing = REQUIRED_FIELDS.filter(f => {
         const v = event[f];
         return v === undefined || v === null || v === '';
      });

      logger.warn(
         buildLogFields({
            type: 'trade_event_skipped',
            missing_fields: missing,
            ledger: event.ledger,
            tx_hash: event.tx_hash,
         }),
         'Skipping trade event with missing required fields'
      );

      return false;
   }

   const existing = await db.trade.findUnique({
      where: {
         ledger_txHash: {
            ledger: event.ledger,
            txHash: event.tx_hash,
         },
      },
      select: { id: true },
   });

   if (existing) {
      return false;
   }

   await db.trade.create({
      data: {
         buyer: event.buyer,
         creatorId: event.creator_id,
         quantity: event.quantity,
         price: event.price,
         ledger: event.ledger,
         txHash: event.tx_hash,
         timestamp: new Date(event.timestamp),
      },
   });

   try {
      const { invalidateCreatorDashboardCache } =
         await import('../creator/creator-dashboard.service');
      await invalidateCreatorDashboardCache(event.creator_id);
   } catch {
      // Non-critical cache invalidation failure
   }

   try {
      const { invalidateKeyAnalyticsCache } =
         await import('../keys/key-analytics.service');
      await invalidateKeyAnalyticsCache(event.creator_id);
   } catch {
      // Non-critical cache invalidation failure
   }

   return true;
}
