// src/modules/admin/dlq-replay.registry.ts
// Replay handlers for DLQ entries (#1341).
//
// Replaying a dead-lettered job means re-running the work that failed, which
// only the owning indexer knows how to do. Each indexer registers a handler for
// its jobType here. An entry whose jobType has no handler is not lost: the
// replay attempt is recorded with outcome NO_HANDLER and the row stays live.

export type DlqReplayHandler = (payload: unknown) => Promise<void>;

const handlers = new Map<string, DlqReplayHandler>();

/** Register (or replace) the replay handler for a DLQ job type. */
export function registerDlqReplayHandler(
   jobType: string,
   handler: DlqReplayHandler
): void {
   handlers.set(jobType, handler);
}

export function getDlqReplayHandler(jobType: string): DlqReplayHandler | undefined {
   return handlers.get(jobType);
}

/** Test hook: remove every registered handler. */
export function clearDlqReplayHandlers(): void {
   handlers.clear();
}
