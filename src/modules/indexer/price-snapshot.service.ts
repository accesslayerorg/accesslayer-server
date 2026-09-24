// src/modules/indexer/price-snapshot.service.ts
// Indexer-side writes to the creator_price_snapshots read model.
// Called on every BUY or SELL trade event.

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';

/** Trade side, mirroring the `TradeDirection` enum in the Prisma schema. */
export type TradeDirectionValue = 'BUY' | 'SELL';

export interface TradeEventPayload {
   creatorId: string;
   /** Trade price in stroops */
   price: bigint;
   /** ISO timestamp of the trade */
   tradeAt: Date;
   /** Ledger sequence number the trade was included in */
   ledger?: number;
   /**
    * Circulating supply the price was computed against, as returned by
    * `persistCirculatingSupply` for this trade. Optional so that older callers
    * (and the debug tooling) keep compiling; stored as 0 when absent.
    */
   supply?: bigint;
   /** Trade side. Defaults to BUY for callers that predate this field. */
   direction?: TradeDirectionValue;
}

/**
 * Upsert the price snapshot for a creator after a trade event.
 *
 * - On first trade: creates the row with currentPrice = price, price24hAgo = 0.
 * - On subsequent trades: updates currentPrice; price24hAgo is updated separately
 *   by a scheduled job (or set inline when the existing record is >24 h old).
 *
 * Each history row carries the supply and the trade direction as well as the
 * price, so price-history consumers can weight points by size and tell buys
 * from sells instead of reconstructing both from the trade log.
 *
 * Idempotent: re-processing the same event produces the same state.
 */
export async function upsertPriceSnapshot(
   event: TradeEventPayload
): Promise<void> {
   const {
      creatorId,
      price,
      tradeAt,
      ledger,
      supply = 0n,
      direction = 'BUY',
   } = event;

   try {
      const existing = await prisma.creatorPriceSnapshot.findUnique({
         where: { creatorId },
      });

      if (!existing) {
         // First ever trade — seed both price fields with current price.
         await prisma.creatorPriceSnapshot.create({
            data: {
               creatorId,
               currentPrice: price,
               price24hAgo: price,
               lastTradeAt: tradeAt,
            },
         });
         await prisma.creatorPriceHistory.create({
            data: {
               creatorId,
               price,
               supply,
               direction,
               recordedAt: tradeAt,
            },
         });
         logger.debug(
            {
               creator_id: creatorId,
               new_price: price.toString(),
               previous_price: null,
               supply: supply.toString(),
               direction,
               ledger: ledger ?? null,
               ingested_at: new Date().toISOString(),
            },
            'price-snapshot: written (first trade)'
         );
         return;
      }

      // Idempotency: skip if this event is older than the last recorded trade.
      if (existing.lastTradeAt && tradeAt <= existing.lastTradeAt) {
         logger.debug(
            { creatorId, tradeAt, lastTradeAt: existing.lastTradeAt },
            'price-snapshot: skipping stale event (idempotency guard)'
         );
         return;
      }

      // Skip write when price is unchanged.
      if (existing.currentPrice.toString() === price.toString()) {
         return;
      }

      // Promote currentPrice → price24hAgo when the snapshot is older than 24 h.
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const shouldRotate24h =
         existing.lastTradeAt && existing.lastTradeAt < twentyFourHoursAgo;

      await prisma.creatorPriceSnapshot.update({
         where: { creatorId },
         data: {
            currentPrice: price,
            price24hAgo: shouldRotate24h
               ? existing.currentPrice
               : existing.price24hAgo,
            lastTradeAt: tradeAt,
         },
      });
      await prisma.creatorPriceHistory.create({
         data: {
            creatorId,
            price,
            supply,
            direction,
            recordedAt: tradeAt,
         },
      });
      logger.debug(
         {
            creator_id: creatorId,
            new_price: price.toString(),
            previous_price: existing.currentPrice.toString(),
            supply: supply.toString(),
            direction,
            ledger: ledger ?? null,
            ingested_at: new Date().toISOString(),
         },
         'price-snapshot: written'
      );
   } catch (err) {
      logger.error({ err, creatorId }, 'price-snapshot: failed to upsert');
      throw err;
   }
}
