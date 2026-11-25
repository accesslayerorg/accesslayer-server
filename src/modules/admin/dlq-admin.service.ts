// src/modules/admin/dlq-admin.service.ts
// Operator tools for the indexer dead-letter queue (#1341).
//
// Live entries are rows with replayedAt = null. A replay is claimed with an
// optimistic update before the handler runs, so two admins replaying the same
// entry cannot both execute it. Every outcome is written to the row and to the
// audit log.

import { IndexerDLQ, Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { getDLQQueueSummary } from '../../utils/indexer-dlq.utils';
import { createAuditEntry } from './audit-log.service';
import { getDlqReplayHandler } from './dlq-replay.registry';

/** Hard cap on jobs replayed by one request. */
export const DLQ_MAX_REPLAY_BATCH = 500;

const PAYLOAD_PREVIEW_CHARS = 500;
const ERROR_MESSAGE_CHARS = 500;

export type DlqReplayOutcome =
   | 'REPLAYED'
   | 'NO_HANDLER'
   | 'FAILED'
   | 'ALREADY_REPLAYED';

export interface DlqEntryView {
   id: string;
   jobType: string;
   failureReason: string;
   errorDetails: string | null;
   /** Attempts made before the job was dead-lettered. */
   attempts: number;
   replayCount: number;
   lastReplayAt: string | null;
   lastReplayOutcome: string | null;
   replayedAt: string | null;
   createdAt: string;
   payloadPreview: string;
}

export interface DlqEntryFilter {
   queue?: string;
   error?: string;
}

export interface DlqReplayResult {
   id: string;
   outcome: DlqReplayOutcome;
   error?: string;
}

function truncate(text: string, max: number): string {
   return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function previewPayload(payload: unknown): string {
   let serialized: string;
   try {
      serialized = JSON.stringify(payload) ?? 'null';
   } catch {
      serialized = '[unserializable payload]';
   }
   return truncate(serialized, PAYLOAD_PREVIEW_CHARS);
}

export function toDlqEntryView(row: IndexerDLQ): DlqEntryView {
   return {
      id: row.id,
      jobType: row.jobType,
      failureReason: row.failureReason,
      errorDetails: row.errorDetails,
      attempts: row.retryCount,
      replayCount: row.replayCount,
      lastReplayAt: row.lastReplayAt ? row.lastReplayAt.toISOString() : null,
      lastReplayOutcome: row.lastReplayOutcome,
      replayedAt: row.replayedAt ? row.replayedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      payloadPreview: previewPayload(row.payload),
   };
}

/** Where clause for live entries, optionally narrowed by queue and error text. */
export function buildLiveDlqWhere(filter: DlqEntryFilter): Prisma.IndexerDLQWhereInput {
   return {
      replayedAt: null,
      ...(filter.queue ? { jobType: filter.queue } : {}),
      ...(filter.error
         ? {
              failureReason: {
                 contains: filter.error,
                 mode: 'insensitive' as const,
              },
           }
         : {}),
   };
}

export interface ListDlqInput extends DlqEntryFilter {
   cursor?: string;
   limit: number;
}

/**
 * Lists live DLQ entries, oldest first, with cursor pagination on id. The
 * `queues` summary covers all live entries, not just the filtered page.
 */
export async function listDlqEntries(input: ListDlqInput) {
   const take = input.limit + 1;
   const rows = await prisma.indexerDLQ.findMany({
      where: buildLiveDlqWhere(input),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
   });

   const hasMore = rows.length > input.limit;
   const page = rows.slice(0, input.limit);
   const queues = await getDLQQueueSummary();

   return {
      entries: page.map(toDlqEntryView),
      nextCursor: hasMore ? page[page.length - 1].id : null,
      hasMore,
      queues,
   };
}

/**
 * Claim one live entry for replay and run its handler. Returns the outcome
 * after recording it on the row. Never throws for handler failures.
 */
async function replayEntry(
   row: IndexerDLQ,
   now: Date
): Promise<DlqReplayResult> {
   // Claim: succeeds only if nobody replayed or claimed this snapshot.
   const claim = await prisma.indexerDLQ.updateMany({
      where: { id: row.id, replayedAt: null, replayCount: row.replayCount },
      data: { replayCount: { increment: 1 }, lastReplayAt: now },
   });
   if (claim.count === 0) {
      return { id: row.id, outcome: 'ALREADY_REPLAYED' };
   }

   const handler = getDlqReplayHandler(row.jobType);
   if (!handler) {
      await prisma.indexerDLQ.update({
         where: { id: row.id },
         data: { lastReplayOutcome: 'NO_HANDLER' },
      });
      return { id: row.id, outcome: 'NO_HANDLER' };
   }

   try {
      await handler(row.payload);
      await prisma.indexerDLQ.update({
         where: { id: row.id },
         data: { replayedAt: now, lastReplayOutcome: 'REPLAYED' },
      });
      return { id: row.id, outcome: 'REPLAYED' };
   } catch (error) {
      const message = truncate(
         error instanceof Error ? error.message : String(error),
         ERROR_MESSAGE_CHARS
      );
      logger.error(
         { dlqId: row.id, jobType: row.jobType, error: message },
         'DLQ replay handler failed'
      );
      await prisma.indexerDLQ.update({
         where: { id: row.id },
         data: { lastReplayOutcome: `FAILED: ${message}` },
      });
      return { id: row.id, outcome: 'FAILED', error: message };
   }
}

/** Replay one live entry by id. Returns null when the id does not exist. */
export async function replayDlqEntry(
   id: string,
   adminId: string,
   now: Date = new Date()
): Promise<DlqReplayResult | null> {
   const row = await prisma.indexerDLQ.findUnique({ where: { id } });
   if (!row) return null;

   const result = await replayEntry(row, now);
   await createAuditEntry({
      actorWallet: adminId,
      actionType: 'dlq_entry_replayed',
      targetId: id,
      payload: { jobType: row.jobType, outcome: result.outcome },
   });
   return result;
}

export interface ReplayBatchInput extends DlqEntryFilter {
   ids?: string[];
   limit?: number;
}

/**
 * Replay up to DLQ_MAX_REPLAY_BATCH live entries selected by ids or by a
 * queue/error filter. Entries run sequentially so handler load stays bounded.
 */
export async function replayDlqBatch(
   input: ReplayBatchInput,
   adminId: string,
   now: Date = new Date()
): Promise<{ requested: number; results: DlqReplayResult[] }> {
   const limit = Math.min(input.limit ?? DLQ_MAX_REPLAY_BATCH, DLQ_MAX_REPLAY_BATCH);

   const where: Prisma.IndexerDLQWhereInput = input.ids?.length
      ? { id: { in: input.ids }, replayedAt: null }
      : buildLiveDlqWhere(input);

   const rows = await prisma.indexerDLQ.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
   });

   const results: DlqReplayResult[] = [];
   for (const row of rows) {
      results.push(await replayEntry(row, now));
   }

   await createAuditEntry({
      actorWallet: adminId,
      actionType: 'dlq_batch_replayed',
      targetId: input.queue ?? 'ids',
      payload: {
         requested: rows.length,
         counts: results.reduce<Record<string, number>>((acc, r) => {
            acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
            return acc;
         }, {}),
         ids: results.map(r => r.id),
      },
   });

   return { requested: rows.length, results };
}

/**
 * Permanently delete a DLQ entry. The delete and its audit record are written
 * in one transaction, so an entry is never removed without an audit trail.
 * Returns false when the id does not exist.
 */
export async function deleteDlqEntry(
   id: string,
   reason: string,
   adminId: string
): Promise<boolean> {
   return prisma.$transaction(async tx => {
      const row = await tx.indexerDLQ.findUnique({ where: { id } });
      if (!row) return false;

      await tx.indexerDLQ.delete({ where: { id } });
      await tx.auditLog.create({
         data: {
            actorWallet: adminId,
            actionType: 'dlq_entry_deleted',
            targetId: id,
            payload: {
               reason,
               jobType: row.jobType,
               failureReason: row.failureReason,
               wasReplayed: row.replayedAt !== null,
            } as Prisma.InputJsonObject,
         },
      });
      return true;
   });
}
