// src/modules/indexer/price-snapshot-writer.ts
// Price snapshot writer that skips the write when the price is unchanged
// from the most recent stored snapshot for that creator (#763).
//
// Recording a snapshot whose price equals the previous one wastes storage
// and adds flat, redundant points to the price history chart. This writer
// compares the incoming price against the latest CreatorPriceHistory row
// and only inserts when the price actually moved. The first snapshot for a
// creator is always written because there is nothing to compare against.
//
// Note: the per-trade indexer path (upsertPriceSnapshot) intentionally keeps
// recording every trade, including unchanged prices, because the full-window
// trade TWAP depends on it (#880). Use this writer for periodic/sampled
// snapshots, not for the trade log.

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';

export type PriceSnapshotWriteResult =
   | { written: true; reason: 'first' | 'changed' }
   | { written: false; reason: 'unchanged' };

export type PriceSnapshotWriterDeps = {
   /** Returns the most recent stored snapshot for the creator, or null. */
   findLatest: (creatorId: string) => Promise<{ price: bigint } | null>;
   /** Persists a new snapshot row for the creator. */
   create: (creatorId: string, price: bigint) => Promise<unknown>;
};

const defaultDeps: PriceSnapshotWriterDeps = {
   findLatest: (creatorId) =>
      prisma.creatorPriceHistory.findFirst({
         where: { creatorId },
         orderBy: { recordedAt: 'desc' },
         select: { price: true },
      }),
   create: (creatorId, price) =>
      prisma.creatorPriceHistory.create({
         data: { creatorId, price },
      }),
};

/**
 * Writes a price snapshot for a creator unless the price is unchanged from
 * the most recent stored snapshot.
 *
 * - No previous snapshot: always written (`reason: 'first'`).
 * - Price differs from the previous snapshot: written (`reason: 'changed'`).
 * - Price equals the previous snapshot: skipped, no database write
 *   (`reason: 'unchanged'`).
 */
export async function writePriceSnapshot(
   creatorId: string,
   price: bigint,
   deps?: Partial<PriceSnapshotWriterDeps>
): Promise<PriceSnapshotWriteResult> {
   const findLatest = deps?.findLatest ?? defaultDeps.findLatest;
   const create = deps?.create ?? defaultDeps.create;

   const latest = await findLatest(creatorId);

   if (latest && latest.price === price) {
      logger.debug(
         { creator_id: creatorId, price: price.toString() },
         'price-snapshot-writer: skipped (price unchanged)'
      );
      return { written: false, reason: 'unchanged' };
   }

   await create(creatorId, price);

   const reason = latest ? 'changed' : 'first';
   logger.debug(
      {
         creator_id: creatorId,
         new_price: price.toString(),
         previous_price: latest ? latest.price.toString() : null,
      },
      `price-snapshot-writer: written (${reason})`
   );
   return { written: true, reason };
}
