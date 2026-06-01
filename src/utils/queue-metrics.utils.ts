/**
 * Lightweight in-process queue depth registry for indexer workers.
 *
 * Each worker calls setQueueDepth() after every poll cycle so the metrics
 * endpoint always reflects the latest observed depth without a DB query.
 *
 * Alerting thresholds (recommended):
 *   pending  > 500  → warning  (backlog building)
 *   pending  > 2000 → critical (worker may be stalled)
 *   failed   > 50   → warning  (retry budget draining)
 *   failed   > 200  → critical (manual intervention needed)
 *   dlq      > 0    → warning  (poisoned messages present)
 */

export type QueueState = 'pending' | 'processing' | 'failed' | 'dlq';

export interface QueueDepthEntry {
  queue: string;
  state: QueueState;
  depth: number;
  updatedAt: string;
}

const registry = new Map<string, QueueDepthEntry>();

function key(queue: string, state: QueueState): string {
  return `${queue}:${state}`;
}

export function setQueueDepth(queue: string, state: QueueState, depth: number): void {
  registry.set(key(queue, state), {
    queue,
    state,
    depth,
    updatedAt: new Date().toISOString(),
  });
}

export function getQueueDepths(): QueueDepthEntry[] {
  return Array.from(registry.values());
}

export function resetQueueMetrics(): void {
  registry.clear();
}
