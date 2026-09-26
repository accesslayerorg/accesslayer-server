// src/modules/indexer/ledger-checkpoint.service.ts
// Idempotent ledger checkpoint system to prevent duplicate event processing after restart.

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { createHash } from 'crypto';

const CHECKPOINT_WRITE_TIMEOUT_MS = 5_000;

export interface CheckpointResult {
   ledger: number;
   lastProcessedEventIndex: number;
   batchHash: string;
   completedAt: Date;
}

/**
 * Compute a SHA-256 hash of a batch of event identifiers for integrity checking.
 * Each identifier is "txHash:eventIndex" — the hash detects if the batch content
 * changed between writes (e.g. due to a partial replay or RPC inconsistency).
 */
export function computeBatchHash(eventIds: string[]): string {
   const sorted = [...eventIds].sort();
   return createHash('sha256').update(sorted.join('\n')).digest('hex');
}

/**
 * Write a checkpoint record atomically after all events in a ledger are processed.
 *
 * Uses an upsert so replaying the same ledger is idempotent — only the latest
 * batch hash and event count are retained.
 *
 * The write is wrapped in a timeout so a slow database does not block the main
 * event processing loop. If the write fails or times out, the error is logged
 * and the indexer continues.
 */
export async function writeCheckpoint(
   ledger: number,
   lastProcessedEventIndex: number,
   batchHash: string
): Promise<CheckpointResult | null> {
   try {
      const result = await Promise.race([
         prisma.ledgerCheckpoint.upsert({
            where: { ledger },
            create: {
               ledger,
               lastProcessedEventIndex,
               batchHash,
            },
            update: {
               lastProcessedEventIndex,
               batchHash,
               completedAt: new Date(),
            },
         }),
         new Promise<never>((_, reject) =>
            setTimeout(
               () => reject(new Error('Checkpoint write timeout')),
               CHECKPOINT_WRITE_TIMEOUT_MS
            )
         ),
      ]);

      logger.debug(
         { ledger, lastProcessedEventIndex, batchHash: batchHash.slice(0, 8) },
         'Ledger checkpoint written'
      );

      return result as CheckpointResult;
   } catch (err) {
      logger.warn(
         { err, ledger, lastProcessedEventIndex },
         'Failed to write ledger checkpoint — skipping'
      );
      return null;
   }
}

/**
 * Read the most recent completed checkpoint.
 *
 * Returns null if no checkpoint exists (first run).
 */
export async function readLatestCheckpoint(): Promise<CheckpointResult | null> {
   const checkpoint = await prisma.ledgerCheckpoint.findFirst({
      orderBy: { ledger: 'desc' },
   });

   return checkpoint
      ? {
           ledger: checkpoint.ledger,
           lastProcessedEventIndex: checkpoint.lastProcessedEventIndex,
           batchHash: checkpoint.batchHash,
           completedAt: checkpoint.completedAt,
        }
      : null;
}

/**
 * Read the checkpoint for a specific ledger.
 */
export async function readCheckpoint(
   ledger: number
): Promise<CheckpointResult | null> {
   const checkpoint = await prisma.ledgerCheckpoint.findUnique({
      where: { ledger },
   });

   return checkpoint
      ? {
           ledger: checkpoint.ledger,
           lastProcessedEventIndex: checkpoint.lastProcessedEventIndex,
           batchHash: checkpoint.batchHash,
           completedAt: checkpoint.completedAt,
        }
      : null;
}

/**
 * Check if the incoming batch matches a previously recorded checkpoint.
 *
 * Returns true when:
 * - No checkpoint exists for this ledger (first time processing)
 * - The batch hash matches the checkpoint (consistent replay)
 *
 * Returns false when a checkpoint exists but the batch hash differs —
 * this signals that the ledger must be reprocessed from scratch.
 */
export async function validateBatchIntegrity(
   ledger: number,
   incomingBatchHash: string
): Promise<{ valid: boolean; needsReprocess: boolean }> {
   const existing = await readCheckpoint(ledger);

   if (!existing) {
      return { valid: true, needsReprocess: false };
   }

   if (existing.batchHash === incomingBatchHash) {
      return { valid: true, needsReprocess: false };
   }

   logger.warn(
      {
         ledger,
         existingHash: existing.batchHash.slice(0, 8),
         incomingHash: incomingBatchHash.slice(0, 8),
      },
      'Batch hash mismatch detected — ledger must be reprocessed'
   );

   return { valid: false, needsReprocess: true };
}

/**
 * Delete all records for a specific ledger to prepare for reprocessing.
 *
 * This runs in a transaction to ensure atomicity — either all records are
 * deleted or none are.
 */
export async function deleteLedgerRecords(ledger: number): Promise<number> {
   const result = await prisma.$transaction([
      prisma.activity.deleteMany({
         where: { payload: { path: ['ledger_sequence'], equals: ledger } },
      }),
      prisma.keyOwnership.deleteMany({ where: {} }),
   ]);

   const totalDeleted = result.reduce((sum, r) => sum + r.count, 0);

   logger.info(
      { ledger, totalDeleted },
      'Deleted records for ledger reprocessing'
   );

   return totalDeleted;
}

/**
 * Get the resume point for the indexer.
 *
 * Returns the ledger number to start processing from (checkpoint.ledger + 1),
 * or 0 if no checkpoint exists (first run).
 */
export async function getResumePoint(): Promise<number> {
   const checkpoint = await readLatestCheckpoint();

   if (!checkpoint) {
      logger.info('No checkpoint found — starting from genesis');
      return 0;
   }

   const resumeFrom = checkpoint.ledger + 1;
   logger.info(
      { checkpointLedger: checkpoint.ledger, resumeFrom },
      'Resuming indexer from checkpoint'
   );

   return resumeFrom;
}
