// src/modules/indexer/reorg-guard.service.ts
// Reorg-aware Stellar event ingestion (#724).
//
// Stellar ledgers are usually final on first observation, but a network
// partition or validator disagreement can cause a short ledger rollback
// (reorg) that invalidates previously ingested events. This module makes the
// ingestion pipeline reorg-aware:
//
//  - `recordLedgerIngestion` stores the ledger sequence + ledger hash for
//    every ingested ledger (LedgerCheckpoint) and every ingested event
//    (IngestedEvent), so the chain linkage is auditable.
//  - `ingestLedger` is the reorg-aware ingestion entry point. Before
//    ingesting a new ledger it verifies
//    `incoming.previousLedgerHash === checkpoint[incoming.sequence - 1].hash`.
//  - On mismatch it finds the fork point by walking backwards through the
//    stored LedgerCheckpoints until the incoming chain's hashes agree,
//    rolls back every database side effect from the fork point forward in a
//    single atomic transaction (`rollbackToLedger`), emits a warn-level
//    structured log with the fork point and affected counts, and re-ingests
//    the canonical ledgers from the fork point forward.
//
// Reversal model for a trade event's side effects:
//  - transaction history entries (Activity KEY_BOUGHT/KEY_SOLD rows and
//    Trade rows) are deleted,
//  - affected KeyOwnership positions are rebuilt by replaying the remaining
//    (non-reorged) trade history through the same weighted-average cost
//    basis / realised P&L math the pipeline uses, which also corrects
//    derived holder counts (they are counted from KeyOwnership balances),
//  - affected CreatorPriceSnapshot / CreatorPriceHistory rows are restored
//    from the latest surviving price history row,
//  - CreatorProfile.circulatingSupply / currentMilestone are recomputed,
//  - the reorged LedgerCheckpoints are deleted so the ledgers can be
//    re-ingested from the fork point.
//
// Everything above happens inside one `prisma.$transaction` so the rollback
// is atomic: either the whole rollback lands or none of it does.

import type { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { dedupeChainEvents } from '../../utils/indexer-dedupe.utils';
import { computeBatchHash } from './ledger-checkpoint.service';
import { processTradeEvents } from './indexer-pipeline.service';
import { getTierForSupply } from '../keys/key-milestones.service';
import type { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

/** One Stellar ledger header as seen on the incoming (canonical) chain. */
export interface LedgerHeader {
   /** Ledger sequence number. */
   sequence: number;
   /** Hash of this ledger itself. */
   hash: string;
   /** Hash this ledger's parent, as carried by this ledger. */
   previousLedgerHash: string | null;
}

/**
 * Upper bound on how far backwards the fork-point walk (and the subsequent
 * re-ingestion) may go. Stellar reorgs are short — a bound keeps a badly
 * wrong hash source from scanning the whole checkpoint history.
 */
export const MAX_FORK_WALKBACK_LEDGERS = 1_000;

/** Injectable dependencies; production callers normally use the defaults. */
export interface ReorgGuardDeps {
   /**
    * Fetch the canonical header for a ledger sequence from the *incoming*
    * chain. Used to walk backwards to the fork point and to re-ingest the
    * canonical ledgers after a rollback. When absent, intermediate ledgers
    * cannot be re-fetched and are left for the caller to re-deliver.
    */
   fetchHeader?: (sequence: number) => Promise<LedgerHeader | null>;
   /**
    * Fetch the ingested events for a ledger on the canonical chain so it can
    * be re-ingested. Required together with `fetchHeader` for re-ingestion.
    */
   fetchEvents?: (sequence: number) => Promise<IndexerChainEvent[]>;
   /**
    * Event processor used for both fresh ingestion and re-ingestion.
    * Defaults to the trade-event pipeline (`processTradeEvents`).
    */
   processEvents?: (events: IndexerChainEvent[]) => Promise<void>;
}

/** Result of detecting and (if needed) rolling back a reorg. */
export interface ReorgOutcome {
   reorgDetected: boolean;
   /** Last canonical ledger that survives the rollback; null when clean. */
   forkPoint: number | null;
   /** Number of ledger checkpoints removed by the rollback. */
   reorgedLedgerCount: number;
   /** Number of ingested events marked REORGED by the rollback. */
   affectedEventCount: number;
}

/** Result of ingesting one ledger through the reorg-aware entry point. */
export interface IngestLedgerResult extends ReorgOutcome {
   sequence: number;
   /** Unique events ingested for the incoming ledger. */
   eventsIngested: number;
   /** Canonical ledgers re-ingested from the fork point, in order. */
   reingestedLedgers: number[];
}

/** Interactive-transaction budget for the rollback (rebuild can be slow). */
const ROLLBACK_TX_TIMEOUT_MS = 60_000;
const ROLLBACK_TX_MAX_WAIT_MS = 10_000;

type Tx = Prisma.TransactionClient;

const TRADE_ACTIVITY_TYPES = ['KEY_BOUGHT', 'KEY_SOLD'] as const;

/** Convert an incoming chain event into an IngestedEvent row payload. */
function toIngestedEventFields(
   event: IndexerChainEvent,
   header: LedgerHeader
): Prisma.IngestedEventUncheckedCreateInput {
   const tradeAt =
      event.tradeAt !== undefined && event.tradeAt !== null
         ? new Date(String(event.tradeAt))
         : null;

   return {
      ledgerSequence:
         typeof event.ledger === 'number' && Number.isFinite(event.ledger)
            ? event.ledger
            : header.sequence,
      ledgerHash: header.hash,
      txHash: event.txHash,
      eventIndex: event.eventIndex,
      eventType: event.eventType,
      actor: typeof event.actor === 'string' ? event.actor : null,
      creatorId:
         typeof event.creatorId === 'string' ? event.creatorId : null,
      amount:
         event.amount !== undefined && event.amount !== null
            ? String(event.amount)
            : null,
      priceStroops:
         event.price !== undefined && event.price !== null
            ? String(event.price)
            : null,
      tradeAt: tradeAt && !Number.isNaN(tradeAt.getTime()) ? tradeAt : null,
   };
}

/**
 * Persist the chain linkage for one ingested ledger: a LedgerCheckpoint
 * carrying the ledger sequence + hash (and the parent hash it chained onto),
 * plus one IngestedEvent row per unique event, in a single transaction.
 *
 * Idempotent: replaying the same ledger upserts the same rows.
 */
export async function recordLedgerIngestion(
   header: LedgerHeader,
   events: IndexerChainEvent[]
): Promise<void> {
   const uniqueEvents = dedupeChainEvents(events);
   const eventIds = uniqueEvents.map(e => `${e.txHash}:${e.eventIndex}`);
   const lastProcessedEventIndex =
      uniqueEvents.length > 0
         ? Math.max(...uniqueEvents.map(e => e.eventIndex))
         : 0;

   await prisma.$transaction(
      async tx => {
         for (const event of uniqueEvents) {
            const fields = toIngestedEventFields(event, header);
            await tx.ingestedEvent.upsert({
               where: {
                  txHash_eventIndex: {
                     txHash: event.txHash,
                     eventIndex: event.eventIndex,
                  },
               },
               create: { ...fields, status: 'CONFIRMED' },
               update: {
                  ...fields,
                  status: 'CONFIRMED',
                  reorgedAt: null,
               },
            });
         }

         await tx.ledgerCheckpoint.upsert({
            where: { ledger: header.sequence },
            create: {
               ledger: header.sequence,
               ledgerHash: header.hash,
               previousLedgerHash: header.previousLedgerHash,
               lastProcessedEventIndex,
               batchHash: computeBatchHash(eventIds),
            },
            update: {
               ledgerHash: header.hash,
               previousLedgerHash: header.previousLedgerHash,
               lastProcessedEventIndex,
               batchHash: computeBatchHash(eventIds),
               completedAt: new Date(),
            },
         });
      },
      {
         timeout: ROLLBACK_TX_TIMEOUT_MS,
         maxWait: ROLLBACK_TX_MAX_WAIT_MS,
      }
   );

   logger.debug(
      {
         ledger: header.sequence,
         ledger_hash: header.hash,
         events: uniqueEvents.length,
      },
      'Ledger ingestion recorded (checkpoint + ingested events)'
   );
}

/**
 * Find the fork point for a diverging incoming ledger.
 *
 * Walks backwards from `header.sequence - 1` through the stored
 * LedgerCheckpoints, comparing each stored hash against the hash the
 * *incoming* chain reports for the same sequence. The fork point is the
 * highest sequence whose hashes still agree — every ledger after it belongs
 * to the abandoned branch and must be rolled back.
 *
 * Returns `header.sequence - 1` when there is nothing stored to compare
 * against (nothing to roll back).
 */
export async function findForkPoint(
   header: LedgerHeader,
   fetchHeader?: (sequence: number) => Promise<LedgerHeader | null>
): Promise<number> {
   const stored = await prisma.ledgerCheckpoint.findMany({
      where: { ledger: { lt: header.sequence } },
      orderBy: { ledger: 'desc' },
      take: MAX_FORK_WALKBACK_LEDGERS,
      select: { ledger: true, ledgerHash: true },
   });

   if (stored.length === 0) {
      return header.sequence - 1;
   }

   const oldestStored = stored[stored.length - 1].ledger;

   for (const checkpoint of stored) {
      const seq = checkpoint.ledger;

      // The incoming ledger directly names its parent's hash; older
      // sequences need the caller's hash source for the incoming chain.
      const incomingHash =
         seq === header.sequence - 1
            ? header.previousLedgerHash
            : fetchHeader
              ? (await fetchHeader(seq))?.hash ?? null
              : null;

      // Cannot walk further without a hash for this sequence on the new
      // chain — roll back everything we can still attribute to the fork.
      if (incomingHash === null) {
         return seq;
      }

      if (incomingHash === checkpoint.ledgerHash) {
         return seq;
      }
   }

   // Every walked ledger disagrees — the whole window is on the abandoned
   // branch; roll back from just before its oldest checkpoint.
   return oldestStored - 1;
}

/**
 * Atomically roll back every database side effect produced at ledgers after
 * `forkPoint`:
 *
 *  - marks the affected IngestedEvent rows REORGED,
 *  - deletes their transaction history entries (Activity + Trade),
 *  - rebuilds the affected KeyOwnership positions from the surviving trade
 *    history (same cost-basis / P&L math as the pipeline), which also
 *    corrects derived holder counts,
 *  - restores affected price snapshots from the surviving price history,
 *  - recomputes circulating supply / milestone for affected creators,
 *  - deletes the reorged LedgerCheckpoints so the ledgers can be re-ingested.
 *
 * Runs inside a single interactive transaction — atomic by construction.
 */
export async function rollbackToLedger(forkPoint: number): Promise<{
   reorgedLedgerCount: number;
   affectedEventCount: number;
}> {
   return prisma.$transaction(
      async tx => {
         const reorgedEvents = await tx.ingestedEvent.findMany({
            where: {
               ledgerSequence: { gt: forkPoint },
               status: 'CONFIRMED',
            },
         });
         const affectedEventCount = reorgedEvents.length;

         const reorgedLedgers = await tx.ledgerCheckpoint.count({
            where: { ledger: { gt: forkPoint } },
         });

         // 1. Mark the affected events REORGED (audit trail).
         await tx.ingestedEvent.updateMany({
            where: { id: { in: reorgedEvents.map(e => e.id) } },
            data: { status: 'REORGED', reorgedAt: new Date() },
         });

         // 2. Remove transaction history entries written by the reorged
         //    ledgers. Trade-side activities carry the ledger sequence in
         //    their payload; Trade rows store it directly.
         await tx.activity.deleteMany({
            where: {
               type: { in: [...TRADE_ACTIVITY_TYPES] },
               payload: { path: ['ledger_sequence'], gt: forkPoint },
            },
         });
         await tx.trade.deleteMany({
            where: { ledger: { gt: forkPoint } },
         });

         const affectedCreators = [
            ...new Set(
               reorgedEvents
                  .map(e => e.creatorId)
                  .filter((id): id is string => typeof id === 'string' && id.length > 0)
            ),
         ];

         // 3. Restore price history + snapshots for affected creators.
         for (const creatorId of affectedCreators) {
            const creatorTradeTimes = reorgedEvents
               .filter(e => e.creatorId === creatorId && e.tradeAt !== null)
               .map(e => e.tradeAt as Date);
            if (creatorTradeTimes.length > 0) {
               const earliestReorgedTradeAt = new Date(
                  Math.min(...creatorTradeTimes.map(d => d.getTime()))
               );
               await tx.creatorPriceHistory.deleteMany({
                  where: {
                     creatorId,
                     recordedAt: { gte: earliestReorgedTradeAt },
                  },
               });
            }

            const latest = await tx.creatorPriceHistory.findFirst({
               where: { creatorId },
               orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
            });

            if (latest) {
               await tx.creatorPriceSnapshot.upsert({
                  where: { creatorId },
                  create: {
                     creatorId,
                     currentPrice: latest.price,
                     price24hAgo: latest.price,
                     lastTradeAt: latest.recordedAt,
                  },
                  update: {
                     currentPrice: latest.price,
                     lastTradeAt: latest.recordedAt,
                  },
               });
            } else {
               await tx.creatorPriceSnapshot.deleteMany({
                  where: { creatorId },
               });
            }
         }

         // 4. Rebuild the affected ownership positions from the surviving
         //    trade history. Replaying the same events through the same
         //    math restores balance, weighted-average cost basis, realised
         //    P&L and lastBuyAt exactly — so holder counts (derived from
         //    balances) follow automatically.
         const affectedPairs = new Map<string, { ownerAddress: string; creatorId: string }>();
         for (const event of reorgedEvents) {
            if (
               TRADE_ACTIVITY_TYPES.includes(event.eventType as any) &&
               typeof event.actor === 'string' &&
               event.actor.length > 0 &&
               typeof event.creatorId === 'string' &&
               event.creatorId.length > 0
            ) {
               affectedPairs.set(`${event.actor}:${event.creatorId}`, {
                  ownerAddress: event.actor,
                  creatorId: event.creatorId,
               });
            }
         }
         for (const pair of affectedPairs.values()) {
            // Drop the post-trade holding snapshots the reorged trades
            // wrote (#1008); re-ingestion re-creates the canonical ones
            // through the normal pipeline.
            const pairTradeTimes = reorgedEvents
               .filter(
                  e =>
                     e.actor === pair.ownerAddress &&
                     e.creatorId === pair.creatorId &&
                     e.tradeAt !== null
               )
               .map(e => e.tradeAt as Date);
            if (pairTradeTimes.length > 0) {
               const earliestPairTradeAt = new Date(
                  Math.min(...pairTradeTimes.map(d => d.getTime()))
               );
               await tx.walletHoldingSnapshot.deleteMany({
                  where: {
                     ownerAddress: pair.ownerAddress,
                     creatorId: pair.creatorId,
                     recordedAt: { gte: earliestPairTradeAt },
                  },
               });
            }

            await rebuildOwnershipPosition(
               // The $extends-ed client's tx is a structural superset of
               // Prisma.TransactionClient.
               tx as unknown as Tx,
               pair.ownerAddress,
               pair.creatorId
            );
         }

         // 5. Recompute derived supply state for affected creators.
         for (const creatorId of affectedCreators) {
            const activities = await tx.activity.findMany({
               where: {
                  creatorId,
                  type: { in: [...TRADE_ACTIVITY_TYPES] },
               },
               select: { type: true, payload: true },
            });
            const supply = activities.reduce(
               (total: number, activity: { type: string; payload: any }) => {
                  const amount = Number(activity.payload?.amount ?? 0);
                  return activity.type === 'KEY_BOUGHT'
                     ? total + amount
                     : total - amount;
               },
               0
            );
            await tx.creatorProfile.update({
               where: { id: creatorId },
               data: {
                  circulatingSupply: supply,
                  currentMilestone: getTierForSupply(supply),
               },
            });
         }

         // 6. Drop the reorged checkpoints so the ledgers can be re-ingested.
         await tx.ledgerCheckpoint.deleteMany({
            where: { ledger: { gt: forkPoint } },
         });

         return { reorgedLedgerCount: reorgedLedgers, affectedEventCount };
      },
      { timeout: ROLLBACK_TX_TIMEOUT_MS, maxWait: ROLLBACK_TX_MAX_WAIT_MS }
   );
}

/**
 * Rebuild one (owner, creator) position by replaying the surviving trade
 * activities in ingestion order, using the same math as
 * `recordKeyPurchase` / `recordKeySale` (ownership.service). Non-derived
 * fields (frozen, lockup) on an existing row are preserved.
 */
async function rebuildOwnershipPosition(
   tx: Tx,
   ownerAddress: string,
   creatorId: string
): Promise<void> {
   const activities = await tx.activity.findMany({
      where: {
         creatorId,
         actor: ownerAddress,
         type: { in: [...TRADE_ACTIVITY_TYPES] },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { type: true, payload: true, createdAt: true },
   });

   let balance = 0;
   let costBasis = 0;
   let realisedPnl = 0;
   let lastBuyAt: Date | null = null;

   for (const activity of activities) {
      const payload = activity.payload as {
         amount?: number;
         price_at_trade?: string;
      };
      const amount = Number(payload?.amount ?? 0);
      // Activity stores the per-key price in stroops; the ownership math
      // works in XLM (same conversion as indexer-pipeline.service).
      let pricePerKeyXlm = Number(payload?.price_at_trade ?? 0) / 10_000_000;
      if (!Number.isFinite(pricePerKeyXlm) || pricePerKeyXlm < 0) {
         pricePerKeyXlm = 0;
      }
      if (!Number.isFinite(amount) || amount === 0) {
         continue;
      }

      if (activity.type === 'KEY_BOUGHT') {
         const previousBalance = balance;
         const newBalance = Math.max(0, balance + amount);
         if (newBalance === 0) {
            costBasis = 0;
         } else if (previousBalance <= 0) {
            costBasis = pricePerKeyXlm;
         } else {
            costBasis =
               (costBasis * previousBalance + pricePerKeyXlm * amount) /
               newBalance;
         }
         balance += amount;
         lastBuyAt = activity.createdAt;
      } else {
         if (balance < amount) {
            // Mirror the pipeline's fallback for out-of-sync history:
            // balance-only decrement without P&L accounting.
            balance -= amount;
            continue;
         }
         realisedPnl += (pricePerKeyXlm - costBasis) * amount;
         balance -= amount;
         if (balance <= 0) {
            costBasis = 0;
         }
      }
   }

   const existing = await tx.keyOwnership.findUnique({
      where: { ownerAddress_creatorId: { ownerAddress, creatorId } },
      select: { id: true },
   });

   if (!existing && activities.length === 0) {
      // Position never existed from the trade history's point of view.
      return;
   }

   if (existing) {
      await tx.keyOwnership.update({
         where: { ownerAddress_creatorId: { ownerAddress, creatorId } },
         data: { balance, costBasis, realisedPnl, lastBuyAt },
      });
   } else {
      await tx.keyOwnership.create({
         data: { ownerAddress, creatorId, balance, costBasis, realisedPnl, lastBuyAt },
      });
   }
}

/**
 * Reorg-aware ingestion entry point: ingest one ledger, verifying that it
 * chains onto the last ingested ledger.
 *
 * Flow:
 *  1. Compare `header.previousLedgerHash` with the stored hash of ledger
 *     `header.sequence - 1`. (No checkpoint → nothing to verify yet, e.g.
 *     first run or a backfill gap — gap handling is #420's domain.)
 *  2. On mismatch: walk back to the fork point, roll everything after it
 *     back in one atomic transaction, emit the reorg warn log, and re-ingest
 *     the canonical ledgers from the fork point forward.
 *  3. Ingest the incoming ledger's events through the trade pipeline and
 *     record the checkpoint + ingested-event rows.
 */
export async function ingestLedger(
   header: LedgerHeader,
   events: IndexerChainEvent[],
   deps: ReorgGuardDeps = {}
): Promise<IngestLedgerResult> {
   const processEvents = deps.processEvents ?? processTradeEvents;
   const uniqueEvents = dedupeChainEvents(events);

   const reorgOutcome: ReorgOutcome = {
      reorgDetected: false,
      forkPoint: null,
      reorgedLedgerCount: 0,
      affectedEventCount: 0,
   };
   const reingestedLedgers: number[] = [];

   const storedParent = await prisma.ledgerCheckpoint.findUnique({
      where: { ledger: header.sequence - 1 },
      select: { ledgerHash: true },
   });

   if (
      storedParent &&
      storedParent.ledgerHash &&
      header.previousLedgerHash &&
      header.previousLedgerHash !== storedParent.ledgerHash
   ) {
      const forkPoint = await findForkPoint(header, deps.fetchHeader);
      const { reorgedLedgerCount, affectedEventCount } =
         await rollbackToLedger(forkPoint);

      // Warn-level structured log emitted on every reorg (#724).
      logger.warn(
         {
            type: 'ledger_reorg_detected',
            forkPoint,
            reorgedLedgerCount,
            affectedEventCount,
            incomingSequence: header.sequence,
            storedParentHash: storedParent.ledgerHash,
            incomingParentHash: header.previousLedgerHash,
            detectedAt: new Date().toISOString(),
         },
         'Ledger reorg detected — rolled back database state from the fork point'
      );

      reorgOutcome.reorgDetected = true;
      reorgOutcome.forkPoint = forkPoint;
      reorgOutcome.reorgedLedgerCount = reorgedLedgerCount;
      reorgOutcome.affectedEventCount = affectedEventCount;

      // Re-ingest the canonical ledgers between the fork point and the
      // incoming ledger when the caller can supply them.
      if (deps.fetchHeader && deps.fetchEvents) {
         for (let seq = forkPoint + 1; seq < header.sequence; seq++) {
            const canonical = await deps.fetchHeader(seq);
            if (!canonical) {
               logger.warn(
                  { type: 'ledger_reorg_reingest_skipped', ledger: seq },
                  'Cannot re-fetch canonical header during reorg recovery; skipping re-ingest'
               );
               break;
            }
            const canonicalEvents = await deps.fetchEvents(seq);
            await processEvents(canonicalEvents);
            await recordLedgerIngestion(canonical, canonicalEvents);
            reingestedLedgers.push(seq);
         }
      } else {
         logger.warn(
            {
               type: 'ledger_reorg_reingest_deferred',
               forkPoint,
               fromLedger: forkPoint + 1,
               toLedger: header.sequence - 1,
            },
            'No re-ingest source configured; caller must re-deliver ledgers from the fork point'
         );
      }
   }

   // Ingest the incoming ledger (fresh, or post-reorg canonical delivery).
   await processEvents(uniqueEvents);
   await recordLedgerIngestion(header, uniqueEvents);

   return {
      ...reorgOutcome,
      sequence: header.sequence,
      eventsIngested: uniqueEvents.length,
      reingestedLedgers,
   };
}
