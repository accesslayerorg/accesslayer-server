import { createHash } from 'crypto';
import { prisma } from '../../utils/prisma.utils';
import {
   recordKeyPurchase,
   recordKeySale,
   updateOwnership,
} from '../ownership/ownership.service';
import { upsertPriceSnapshot } from './price-snapshot.service';
import { updateIndexedLedger } from './ledger-gap-detection.service';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { dedupeChainEvents } from '../../utils/indexer-dedupe.utils';
import { logSellTransactionConfirmed } from '../../utils/sell-transaction-logger.utils';
import { persistCirculatingSupply } from './persist-circulating-supply.service';
import { invalidateVolumeLeaderboardCache } from '../creators/creator-leaderboard-volume.service';
import { invalidateCreatorPortfolioStatsCache } from '../creators/creator-portfolio.service';

/**
 * Processes a batch of on-chain trade events (KEY_BOUGHT or KEY_SOLD).
 *
 * - Deduplicates the events based on txHash and eventIndex.
 * - Parses and validates each event.
 * - Creates an Activity record (representing the trade).
 * - Updates the KeyOwnership read model.
 * - Recomputes circulating supply from the activity log.
 * - Upserts the CreatorPriceSnapshot read model and appends a
 *   CreatorPriceHistory row (price, post-trade supply, direction) in the
 *   same transaction, for TWAP calculations and historical price charts (#893).
 * - Writes a checkpoint record of the highest ledger processed.
 */
export async function processTradeEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (event.eventType === 'CREATOR_REGISTERED') {
         if (typeof event.actor === 'string' && event.actor.length > 0) {
            await invalidateCreatorPortfolioStatsCache(event.actor);
         }
         return;
      }

      // Validate event type
      if (event.eventType !== 'KEY_BOUGHT' && event.eventType !== 'KEY_SOLD') {
         return;
      }

      // Check required fields. Skip with a warn-level log if any is missing.
      const requiredFields = [
         'creatorId',
         'actor',
         'amount',
         'price',
         'feePaid',
         'tradeAt',
         'ledger',
      ];
      for (const field of requiredFields) {
         if (
            event[field] === undefined ||
            event[field] === null ||
            event[field] === ''
         ) {
            logger.warn(
               {
                  eventId: `${event.txHash}:${event.eventIndex}`,
                  missingField: field,
               },
               'Skipping trade event due to missing required field'
            );
            return;
         }
      }

      const { creatorId, actor, amount, price, feePaid, tradeAt, ledger } =
         event;

      // 1. Create corresponding Activity record
      await prisma.activity.create({
         data: {
            type: event.eventType as any,
            actor,
            creatorId,
            payload: {
               amount: Number(amount),
               price_at_trade: price.toString(),
               fee_paid: feePaid.toString(),
               ledger_sequence: Number(ledger),
            },
            createdAt: new Date(tradeAt),
         },
      });

      // Invalidate the volume leaderboard cache so it reflects this trade
      // instead of waiting out the full TTL (#785).
      await invalidateVolumeLeaderboardCache();

      // 2. Ownership read model (#897):
      // - buys go through recordKeyPurchase so the weighted-average cost
      //   basis is updated on every buy (reset when rebuilding from zero).
      // - sells go through recordKeySale so realised P&L is persisted at
      //   execution time. Falls back to balance-only update when the DB has
      //   no matching open position (out-of-sync replay) to avoid breaking
      //   the pipeline.
      // Event `price` is the unit (per-key) bonding-curve price in stroops,
      // consistent with upsertPriceSnapshot below.
      const tradeQty = Number(amount);
      let pricePerKeyXlm = 0;
      try {
         pricePerKeyXlm = Number(BigInt(price as any)) / 10_000_000;
      } catch {
         pricePerKeyXlm = Number(price as any);
      }
      if (!Number.isFinite(pricePerKeyXlm) || pricePerKeyXlm < 0) {
         pricePerKeyXlm = 0;
      }
      if (event.eventType === 'KEY_BOUGHT') {
         await recordKeyPurchase(
            actor,
            creatorId,
            tradeQty,
            pricePerKeyXlm,
            new Date(tradeAt)
         );
      } else {
         try {
            await recordKeySale(actor, creatorId, tradeQty, pricePerKeyXlm);
         } catch {
            const balanceChange = -tradeQty;
            await updateOwnership(actor, creatorId, balanceChange, {
               event_type: 'sell',
               ledger_sequence: Number(ledger),
            });
         }
      }

      // 3. Recompute circulating supply first so the price snapshot/history
      // row records the supply *after* this trade (#893).
      const supplyAfterTrade = await persistCirculatingSupply(creatorId);

      // 4. upsertPriceSnapshot — records the price snapshot atomically with
      // the post-trade supply and trade direction, for TWAP and historical
      // price charts (#893).
      await upsertPriceSnapshot({
         creatorId,
         price: BigInt(price),
         tradeAt: new Date(tradeAt),
         ledger: Number(ledger),
         supply: BigInt(supplyAfterTrade),
         direction: event.eventType === 'KEY_BOUGHT' ? 'BUY' : 'SELL',
      });

      // 5. Emit a structured log for confirmed sells, mirroring buy-side logging.
      if (event.eventType === 'KEY_SOLD') {
         const [creatorProfile, supplyAggregate] = await Promise.all([
            prisma.creatorProfile.findUnique({
               where: { id: creatorId },
               select: {
                  user: {
                     select: { stellarWallet: { select: { address: true } } },
                  },
               },
            }),
            prisma.keyOwnership.aggregate({
               where: { creatorId },
               _sum: { balance: true },
            }),
         ]);

         logSellTransactionConfirmed({
            sellerWallet: actor,
            creatorWallet: creatorProfile?.user?.stellarWallet?.address ?? '',
            keyAmount: Number(amount),
            xlmReceivedStroops: BigInt(price),
            newSupply: Number(supplyAggregate._sum.balance ?? 0),
            txHash: event.txHash,
            confirmedAt: new Date(tradeAt),
         });
      }
   });

   const uniqueEvents = dedupeChainEvents(events);

   const processedLedgers = uniqueEvents
      .map(e => e.ledger)
      .filter((l): l is number => typeof l === 'number');

   if (processedLedgers.length > 0) {
      const maxLedger = Math.max(...processedLedgers);
      const batchHash = computeBatchHash(uniqueEvents);
      const cursor = `${maxLedger}-000`;
      await updateIndexedLedger(maxLedger, cursor, batchHash);
   }
}

function computeBatchHash(
   events: Array<{ txHash: string; eventIndex: number }>
): string {
   const identifiers = events
      .map(e => `${e.txHash}:${e.eventIndex}`)
      .sort()
      .join('|');
   return createHash('sha256')
      .update(identifiers, 'utf8')
      .digest('hex')
      .slice(0, 16);
}
