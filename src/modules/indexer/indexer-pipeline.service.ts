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
import { recordFirstTradeReferralReward } from '../referrals/referrals.service';
import { invalidateCreatorPortfolioStatsCache } from '../creators/creator-portfolio.service';
import { invalidateActivityFeedCache } from '../activity/activity-feed.service';
import {
   processSocialMetadataEvents,
   SOCIAL_METADATA_UPDATED_EVENT_TYPE,
} from './social-metadata-indexer.service';

function isTradeEvent(event: IndexerChainEvent): boolean {
   return (
      event.eventType === 'KEY_BOUGHT' || event.eventType === 'KEY_SOLD'
   );
}

function isGovernanceProposalEvent(event: IndexerChainEvent): boolean {
   return (
      event.eventType === 'PROPOSAL_CREATED' ||
      event.eventType === 'ProposalCreated' ||
      event.eventType === 'VOTE_CAST' ||
      event.eventType === 'VoteCast' ||
      event.eventType === 'PROPOSAL_EXECUTED' ||
      event.eventType === 'ProposalExecuted'
   );
}

export interface TradeEventProcessingOptions {
   /**
    * Advance the shared ledger cursor after processing the batch.
    * Defaults to true so direct callers keep the original behavior; the
    * pipeline dispatcher (`processIndexerEvents`) sets it to false and
    * advances the cursor once over the whole mixed batch instead.
    */
   advanceCursor?: boolean;
}
import {
   processVolumeDiscountTierEvents,
   VOLUME_DISCOUNT_EVENT_TYPES,
} from './volume-discount-tier-indexer.service';
import { invalidateTraderDiscountCache } from '../traders/trader-discount.service';
import { broadcastSwapPrice } from '../price-stream/price-stream.gateway';
import {
   SWAP_EVENT_TYPES,
   processAtomicSwapEvent,
   markExpiredSwaps,
} from './atomic-swap-indexer.service';

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
   events: IndexerChainEvent[],
   options: TradeEventProcessingOptions = {}
): Promise<void> {
   const { advanceCursor = true } = options;

   await processIndexerChainEvents(events, async event => {
      if (event.eventType === 'CREATOR_REGISTERED') {
         if (typeof event.actor === 'string' && event.actor.length > 0) {
            await invalidateCreatorPortfolioStatsCache(event.actor);
         }
         return;
      }

      if (
         event.eventType === 'BundleExecuted' ||
         event.eventType === 'BUNDLE_EXECUTED'
      ) {
         const { processBundleTradeEvent } =
            await import('./bundle-trade-indexer.service');
         await processBundleTradeEvent(event as any, prisma);
         return;
      }

      if (VOLUME_DISCOUNT_EVENT_TYPES.has(event.eventType)) {
         await processVolumeDiscountTierEvents([event]);
         return;
      }

      if (SWAP_EVENT_TYPES.has(event.eventType)) {
         await processAtomicSwapEvent(event as any, prisma);
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
      // payment_asset is optional — absent events default to 'XLM' (#934).
      const paymentAsset: string =
         typeof event.paymentAsset === 'string' &&
         event.paymentAsset.trim() !== ''
            ? event.paymentAsset.trim().toUpperCase()
            : 'XLM';

      // Run referral bookkeeping before the non-transactional trade writes so
      // a failure can abort this event and let the indexer retry it.
      // The conditional claim makes a successful referral write replay-safe.
      try {
         await recordFirstTradeReferralReward({
            refereeAddress: actor,
            keyId: creatorId,
            tradeValueXlm: pricePerKeyXlm * tradeQty,
            txHash: event.txHash,
            eventIndex: event.eventIndex,
            tradeAt: new Date(tradeAt),
         });
      } catch (error) {
         logger.warn(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               error,
            },
            'Failed to record referral first trade reward'
         );
         throw error;
      }
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
               payment_asset: paymentAsset,
            },
            createdAt: new Date(tradeAt),
         },
      });

      // Invalidate the volume leaderboard cache so it reflects this trade
      // instead of waiting out the full TTL (#785).
      await invalidateVolumeLeaderboardCache();

      // Invalidate the platform activity feed's cached first page (#936) so
      // this new KEY_BOUGHT ("investment") activity shows up promptly.
      await invalidateActivityFeedCache();

      // Invalidate trader's 30d volume discount cache so subsequent lookups reflect the new trade (#1030).
      await invalidateTraderDiscountCache(actor);

      // 2. Ownership read model (#897):
      // - buys go through recordKeyPurchase so the weighted-average cost
      //   basis is updated on every buy (reset when rebuilding from zero).
      // - sells go through recordKeySale so realised P&L is persisted at
      //   execution time. Falls back to balance-only update when the DB has
      //   no matching open position (out-of-sync replay) to avoid breaking
      //   the pipeline.
      // Event `price` is the unit (per-key) bonding-curve price in stroops,
      // consistent with upsertPriceSnapshot below.
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
            await recordKeySale(
               actor,
               creatorId,
               tradeQty,
               pricePerKeyXlm,
               new Date(tradeAt)
            );
         } catch {
            const balanceChange = -tradeQty;
            await updateOwnership(actor, creatorId, balanceChange, {
               event_type: 'sell',
               ledger_sequence: Number(ledger),
               occurredAt: new Date(tradeAt),
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

      broadcastSwapPrice({
         key_id: creatorId,
         price: pricePerKeyXlm.toString(),
         amount: String(amount),
         direction: event.eventType === 'KEY_BOUGHT' ? 'buy' : 'sell',
         timestamp: new Date(tradeAt).toISOString(),
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

   if (!advanceCursor) {
      return;
   }

   await advanceIndexerCursorForBatch(events);
}

/**
 * Advances the shared ledger cursor to the highest ledger in the batch.
 *
 * The cursor is a single global checkpoint (`IndexedLedger`, id=1) that the
 * worker uses to resume polling, so it must only move forward over events
 * that have already been fully processed.
 */
export async function advanceIndexerCursorForBatch(
   events: IndexerChainEvent[]
): Promise<void> {
   await markExpiredSwaps(prisma, new Date());

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

/**
 * Processes a mixed batch of indexer events (trades, social metadata and
 * TWAPUpdated observations).
 *
 * Routes each event type to its handler and advances the ledger cursor
 * exactly once, over the full batch, so batches containing only social
 * metadata events still make cursor progress.
 */
export async function processIndexerEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   const tradeEvents = events.filter(isTradeEvent);
   const socialEvents = events.filter(
      event => event.eventType === SOCIAL_METADATA_UPDATED_EVENT_TYPE
   );

   if (socialEvents.length > 0) {
      await processSocialMetadataEvents(socialEvents);
   }

   // TWAPUpdated (#1082). Awaited before the cursor moves: if this throws,
   // the cursor stays put and the whole batch is redelivered, which is what
   // keeps the twap_snapshots history free of gaps.
   // Lazy import, as for the bundle indexer, so Redis is only loaded when a
   // TWAP event actually arrives.
   const twapEvents = events.filter(
      event =>
         event.eventType === 'TWAP_UPDATED' ||
         event.eventType === 'TWAPUpdated'
   );
   if (twapEvents.length > 0) {
      const { processTwapUpdatedEvents } = await import(
         './twap-indexer.service'
      );
      await processTwapUpdatedEvents(twapEvents);
   }

   // Governance lifecycle events (PROPOSAL_CREATED / VOTE_CAST /
   // PROPOSAL_EXECUTED). Processed in order before the cursor moves so a
   // batch that creates a proposal and records its votes stays consistent.
   const governanceEvents = events.filter(isGovernanceProposalEvent);
   if (governanceEvents.length > 0) {
      const { processGovernanceProposalEvents } = await import(
         './governance-proposal-indexer.service'
      );
      await processGovernanceProposalEvents(governanceEvents);
   }

   if (tradeEvents.length > 0) {
      await processTradeEvents(tradeEvents, { advanceCursor: false });
   }

   await advanceIndexerCursorForBatch(events);
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

/**
 * Processes a batch of on-chain KeySunsetFlagged events (#931).
 *
 * Each event stamps `sunsetFlaggedAt` on the matching CreatorProfile and
 * writes a KEY_SUNSET_FLAGGED Activity record so the flag appears in the
 * audit trail.  Already-flagged keys are skipped (idempotent).
 *
 * Expected event fields:
 *   - eventType  : 'KEY_SUNSET_FLAGGED'
 *   - creatorId  : creator profile ID the flag applies to
 *   - flaggedAt  : ISO-8601 timestamp from the contract (optional; falls back to now)
 *   - ledger     : ledger sequence number
 *   - txHash     : transaction hash (for dedup)
 *   - eventIndex : position within the transaction (for dedup)
 */
export async function processSunsetFlaggedEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (event.eventType !== 'KEY_SUNSET_FLAGGED') {
         return;
      }

      const requiredFields = ['creatorId', 'ledger'];
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
               'Skipping KEY_SUNSET_FLAGGED event due to missing required field'
            );
            return;
         }
      }

      const creatorId = String(event.creatorId);
      const flaggedAt = event.flaggedAt
         ? new Date(String(event.flaggedAt))
         : new Date();

      // Resolve to the canonical profile ID (event may carry handle or id).
      const profile = await prisma.creatorProfile.findFirst({
         where: { OR: [{ id: creatorId }, { handle: creatorId }] },
         select: { id: true, sunsetFlaggedAt: true },
      });

      if (!profile) {
         logger.warn(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               creatorId,
            },
            'KEY_SUNSET_FLAGGED event references unknown creator; skipping'
         );
         return;
      }

      // Idempotent: if the flag is already set, skip further writes.
      if (profile.sunsetFlaggedAt !== null) {
         logger.info(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               creatorId: profile.id,
               sunsetFlaggedAt: profile.sunsetFlaggedAt.toISOString(),
            },
            'KEY_SUNSET_FLAGGED already recorded; skipping duplicate event'
         );
         return;
      }

      await prisma.$transaction([
         // Stamp the flag on the creator profile.
         prisma.creatorProfile.update({
            where: { id: profile.id },
            data: { sunsetFlaggedAt: flaggedAt },
         }),
         // Write an Activity record for the audit trail.
         prisma.activity.create({
            data: {
               type: 'KEY_SUNSET_FLAGGED' as any,
               actor: creatorId,
               creatorId: profile.id,
               payload: {
                  ledger_sequence: Number(event.ledger),
                  flagged_at: flaggedAt.toISOString(),
               },
               createdAt: flaggedAt,
            },
         }),
      ]);

      logger.info(
         {
            creatorId: profile.id,
            sunsetFlaggedAt: flaggedAt.toISOString(),
            ledger: event.ledger,
            txHash: event.txHash,
         },
         'KEY_SUNSET_FLAGGED event processed; creator profile stamped'
      );
   });
}
