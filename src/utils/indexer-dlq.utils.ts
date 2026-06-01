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
 * Retrieves the current depth of the DLQ for a specific job type.
 */
export async function getDLQDepth(jobType?: string) {
  return await prisma.indexerDLQ.count({
    where: jobType ? { jobType } : undefined,
  });
}

/**
 * Syncs the current DLQ depth from the database to the in-process metrics registry.
 */
export async function syncDLQMetrics() {
  const depth = await getDLQDepth();
  setQueueDepth('indexer', 'dlq', depth);
}
