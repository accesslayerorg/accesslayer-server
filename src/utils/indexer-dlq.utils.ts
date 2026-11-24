import { prisma } from './prisma.utils';
import { setQueueDepth } from './queue-metrics.utils';

export interface MoveToDLQParams {
   jobType: string;
   payload: any;
   retryCount: number;
   failureReason: string;
   errorDetails?: string;
}

/**
 * Moves a failed indexing job to the Dead-Letter Queue (DLQ).
 *
 * Call this when a job has exhausted its retry attempts or encountered
 * a terminal error that requires manual intervention.
 */
export async function moveToDLQ(params: MoveToDLQParams) {
   return await prisma.indexerDLQ.create({
      data: {
         jobType: params.jobType,
         payload: params.payload,
         retryCount: params.retryCount,
         failureReason: params.failureReason,
         errorDetails: params.errorDetails,
      },
   });
}

/**
 * Retrieves the live depth of the DLQ (entries not yet successfully replayed),
 * optionally restricted to one job type (the DLQ "queue").
 */
export async function getDLQDepth(jobType?: string) {
   return await prisma.indexerDLQ.count({
      where: {
         replayedAt: null,
         ...(jobType ? { jobType } : {}),
      },
   });
}

/**
 * Syncs the current DLQ depth from the database to the in-process metrics registry.
 */
export async function syncDLQMetrics() {
   const depth = await getDLQDepth();
   setQueueDepth('indexer', 'dlq', depth);
}

export interface DlqQueueSummary {
   /** The DLQ job type, reported as its own queue. */
   queue: string;
   /** Live (not yet replayed) entries for this job type. */
   depth: number;
   /** Age in seconds of the oldest live entry for this job type. */
   oldestAgeSeconds: number;
}

/**
 * Live DLQ depth and oldest-entry age per job type (#1341). Each job type is
 * its own queue so alerts can point at the poisoned job rather than the total.
 */
export async function getDLQQueueSummary(
   now: Date = new Date()
): Promise<DlqQueueSummary[]> {
   const groups = await prisma.indexerDLQ.groupBy({
      by: ['jobType'],
      where: { replayedAt: null },
      _count: { _all: true },
      _min: { createdAt: true },
   });

   return groups.map(group => {
      const oldest = group._min.createdAt;
      const oldestAgeSeconds = oldest
         ? Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 1000))
         : 0;
      return {
         queue: group.jobType,
         depth: group._count._all,
         oldestAgeSeconds,
      };
   });
}

/** Publishes per-queue DLQ depth and oldest age to the metrics registry. */
export async function syncDLQQueueMetrics(now: Date = new Date()) {
   for (const summary of await getDLQQueueSummary(now)) {
      setQueueDepth(
         summary.queue,
         'dlq',
         summary.depth,
         summary.oldestAgeSeconds
      );
   }
}
