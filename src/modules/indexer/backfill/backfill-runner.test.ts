import { buildBackfillPlan } from './backfill-plan';
import {
   BackfillStore,
   ShardRecord,
   ShardStats,
   runBackfill,
   verifyBackfillRun,
} from './backfill-runner';
import { BackfillEvent, BackfillEventSource, BackfillPageQuery, validatePage, BackfillSourceError, createHttpEventSource } from './backfill-source';
import { createThrottle } from './backfill-throttle';

const CONTRACT = 'C' + 'A'.repeat(55);

/** In-memory store with the same claim semantics as the Prisma store. */
function memoryStore() {
   const shards = new Map<string, ShardRecord>();
   const claims = new Set<string>();
   const key = (runKey: string, shardIndex: number) => `${runKey}:${shardIndex}`;

   const store: BackfillStore & { claims: Set<string>; shards: Map<string, ShardRecord> } = {
      claims,
      shards,
      async ensureShards(plan) {
         for (const range of plan.ranges) {
            if (!shards.has(key(plan.runKey, range.shardIndex))) {
               shards.set(key(plan.runKey, range.shardIndex), {
                  runKey: plan.runKey,
                  shardIndex: range.shardIndex,
                  fromLedger: range.fromLedger,
                  toLedger: range.toLedger,
                  status: 'PENDING',
                  attempts: 0,
                  eventsFetched: 0,
                  eventsInserted: 0,
                  eventsDuplicate: 0,
                  lastError: null,
               });
            }
         }
      },
      async listShards(runKey) {
         return [...shards.values()].filter(row => row.runKey === runKey).sort((a, b) => a.shardIndex - b.shardIndex);
      },
      async markRunning(runKey, shardIndex) {
         const row = shards.get(key(runKey, shardIndex))!;
         shards.set(key(runKey, shardIndex), { ...row, status: 'RUNNING', attempts: row.attempts + 1 });
      },
      async markCompleted(runKey, shardIndex, stats: ShardStats) {
         const row = shards.get(key(runKey, shardIndex))!;
         shards.set(key(runKey, shardIndex), { ...row, ...stats, status: 'COMPLETED', lastError: null });
      },
      async markFailed(runKey, shardIndex, error, stats: ShardStats) {
         const row = shards.get(key(runKey, shardIndex))!;
         shards.set(key(runKey, shardIndex), { ...row, ...stats, status: 'FAILED', lastError: error });
      },
      async claimEvent(event) {
         const id = `${event.txHash}:${event.eventIndex}`;
         if (claims.has(id)) return false;
         claims.add(id);
         return true;
      },
      async releaseEvent(event) {
         claims.delete(`${event.txHash}:${event.eventIndex}`);
      },
   };
   return store;
}

/** Source backed by a fixed event list, paginated by page size. */
function fixedSource(events: BackfillEvent[], pageSize = 2): BackfillEventSource & { calls: BackfillPageQuery[] } {
   const calls: BackfillPageQuery[] = [];
   return {
      calls,
      async fetchPage(query) {
         calls.push(query);
         const inRange = events.filter(e => e.ledger >= query.fromLedger && e.ledger <= query.toLedger);
         const offset = query.cursor ? Number(query.cursor) : 0;
         const slice = inRange.slice(offset, offset + pageSize);
         const next = offset + pageSize < inRange.length ? String(offset + pageSize) : null;
         return { events: slice, nextCursor: next };
      },
   };
}

function event(ledger: number, index: number, txHash = `tx${ledger}`): BackfillEvent {
   return { txHash, eventIndex: index, ledger, eventType: 'KEY_BOUGHT', actor: 'GX', creatorId: 'c1', amount: '1' };
}

const noThrottle = undefined;

describe('runBackfill', () => {
   it('processes every shard and applies every event exactly once', async () => {
      const plan = buildBackfillPlan({ contractId: CONTRACT, fromLedger: 1, toLedger: 40, shards: 4 });
      const events = [event(2, 0), event(12, 0), event(25, 0), event(39, 1)];
      const store = memoryStore();
      const applied: string[] = [];

      const summary = await runBackfill(plan, {
         source: fixedSource(events),
         store,
         applyEvent: async e => {
            applied.push(`${e.txHash}:${e.eventIndex}`);
         },
         concurrency: 2,
         throttle: noThrottle,
      });

      expect(summary.shardsTotal).toBe(4);
      expect(summary.shardsCompleted).toBe(4);
      expect(summary.shardsFailed).toBe(0);
      expect(summary.eventsInserted).toBe(4);
      expect(applied.sort()).toEqual(['tx12:0', 'tx2:0', 'tx25:0', 'tx39:1']);
   });

   it('skips shards that are already COMPLETED when the same plan is re-run', async () => {
      const plan = buildBackfillPlan({ contractId: CONTRACT, fromLedger: 1, toLedger: 40, shards: 4 });
      const store = memoryStore();
      const source = fixedSource([event(2, 0), event(25, 0)]);
      const apply = jest.fn(async () => undefined);

      await runBackfill(plan, { source, store, applyEvent: apply, concurrency: 1 });
      const callsAfterFirstRun = source.calls.length;

      const second = await runBackfill(plan, { source, store, applyEvent: apply, concurrency: 1 });

      expect(second.shardsSkipped).toBe(4);
      expect(source.calls.length).toBe(callsAfterFirstRun);
      expect(apply).toHaveBeenCalledTimes(2);
   });

   it('does not duplicate events that appear in overlapping ledger ranges', async () => {
      // Two shards share ledger 25 through their source pages, so the same
      // event is fetched twice. The claim must let only one application through.
      const plan = buildBackfillPlan({ contractId: CONTRACT, fromLedger: 1, toLedger: 40, shards: 2 });
      const shared = event(25, 0);
      const source: BackfillEventSource = {
         async fetchPage() {
            return { events: [shared], nextCursor: null };
         },
      };
      const store = memoryStore();
      const apply = jest.fn(async () => undefined);

      const summary = await runBackfill(plan, { source, store, applyEvent: apply, concurrency: 2 });

      expect(apply).toHaveBeenCalledTimes(1);
      expect(summary.eventsInserted).toBe(1);
      expect(summary.eventsDuplicate).toBe(1);
    });

   it('fails only the shard whose event fails, releases its claim, and reports the error', async () => {
      const plan = buildBackfillPlan({ contractId: CONTRACT, fromLedger: 1, toLedger: 40, shards: 2 });
      const bad = event(30, 0, 'bad');
      const store = memoryStore();
      const apply = jest.fn(async (e: BackfillEvent) => {
         if (e.txHash === 'bad') throw new Error('domain write failed');
      });

      const summary = await runBackfill(plan, {
         source: fixedSource([event(5, 0), bad]),
         store,
         applyEvent: apply,
         concurrency: 2,
      });

      expect(summary.shardsFailed).toBe(1);
      expect(summary.failures).toEqual([{ shardIndex: 1, error: 'domain write failed' }]);
      expect(summary.shardsCompleted).toBe(1);
      expect(store.claims.has('bad:0')).toBe(false);
    });

   it('retries a failed shard on the next run and applies its events then', async () => {
      const plan = buildBackfillPlan({ contractId: CONTRACT, fromLedger: 1, toLedger: 10, shards: 1 });
      const store = memoryStore();
      let fail = true;
      const apply = jest.fn(async () => {
         if (fail) throw new Error('transient');
      });
      const source = fixedSource([event(3, 0)]);

      const first = await runBackfill(plan, { source, store, applyEvent: apply, concurrency: 1 });
      fail = false;
      const second = await runBackfill(plan, { source, store, applyEvent: apply, concurrency: 1 });

      expect(first.shardsFailed).toBe(1);
      expect(second.shardsCompleted).toBe(1);
      expect(second.eventsInserted).toBe(1);
      expect(store.shards.get(`${plan.runKey}:0`)!.attempts).toBe(2);
    });

   it('rejects a concurrency below one', async () => {
      const plan = buildBackfillPlan({ contractId: CONTRACT, fromLedger: 1, toLedger: 10, shards: 1 });
      await expect(
         runBackfill(plan, { source: fixedSource([]), store: memoryStore(), applyEvent: async () => undefined, concurrency: 0 })
      ).rejects.toThrow('concurrency must be a positive integer');
   });
});

describe('verifyBackfillRun', () => {
   it('reports no mismatches for a clean run', async () => {
      const plan = buildBackfillPlan({ contractId: CONTRACT, fromLedger: 1, toLedger: 40, shards: 2 });
      const store = memoryStore();
      await runBackfill(plan, { source: fixedSource([event(2, 0), event(30, 0)]), store, applyEvent: async () => undefined, concurrency: 2 });

      const report = await verifyBackfillRun(plan.runKey, store, async () => 2);

      expect(report.shardsChecked).toBe(2);
      expect(report.mismatches).toEqual([]);
    });

   it('lists shards that are not completed', async () => {
      const plan = buildBackfillPlan({ contractId: CONTRACT, fromLedger: 1, toLedger: 40, shards: 2 });
      const store = memoryStore();
      await runBackfill(plan, {
         source: fixedSource([event(30, 0)]),
         store,
         applyEvent: async () => {
            throw new Error('boom');
         },
         concurrency: 2,
      });

      const report = await verifyBackfillRun(plan.runKey, store, async () => 0);

      expect(report.mismatches).toEqual([expect.objectContaining({ shardIndex: 1, reason: expect.stringContaining('FAILED') })]);
   });

   it('flags inserted events that are missing from the ledger range', async () => {
      const plan = buildBackfillPlan({ contractId: CONTRACT, fromLedger: 1, toLedger: 10, shards: 1 });
      const store = memoryStore();
      await runBackfill(plan, { source: fixedSource([event(3, 0)]), store, applyEvent: async () => undefined, concurrency: 1 });

      const report = await verifyBackfillRun(plan.runKey, store, async () => 0);

      expect(report.mismatches).toEqual([expect.objectContaining({ shardIndex: 0, reason: expect.stringContaining('only 0 present') })]);
   });
});

describe('validatePage', () => {
   const query: BackfillPageQuery = { contractId: CONTRACT, fromLedger: 10, toLedger: 20, cursor: null, limit: 100 };

   it('accepts well-formed events inside the requested range', () => {
      const page = validatePage({ events: [event(15, 0)], nextCursor: null }, query);
      expect(page.events).toHaveLength(1);
      expect(page.nextCursor).toBeNull();
    });

   it('rejects an event outside the shard range rather than applying it', () => {
      expect(() => validatePage({ events: [event(99, 0)], nextCursor: null }, query)).toThrow(BackfillSourceError);
   });

   it('rejects events missing identity fields', () => {
      expect(() => validatePage({ events: [{ ledger: 12, eventType: 'KEY_BOUGHT' }], nextCursor: null }, query)).toThrow(
         /no txHash/
      );
      expect(() => validatePage({ events: [{ txHash: 'a', eventIndex: -1, ledger: 12, eventType: 'X' }], nextCursor: null }, query)).toThrow(
         /invalid eventIndex/
      );
   });

   it('rejects a response without an events array', () => {
      expect(() => validatePage({ nextCursor: null }, query)).toThrow(/missing an events array/);
   });
});

describe('createHttpEventSource', () => {
   it('builds the export query and returns a validated page', async () => {
      const fetchImpl = jest.fn(async (_url: string) => ({
         ok: true,
         status: 200,
         json: async () => ({ events: [event(12, 0)], nextCursor: 'c2' }),
      }));
      const source = createHttpEventSource({ baseUrl: 'https://worker.example/export', fetchImpl });

      const page = await source.fetchPage({ contractId: CONTRACT, fromLedger: 10, toLedger: 20, cursor: 'c1', limit: 50 });

      const requested = new URL(fetchImpl.mock.calls[0][0]);
      expect(requested.searchParams.get('contractId')).toBe(CONTRACT);
      expect(requested.searchParams.get('fromLedger')).toBe('10');
      expect(requested.searchParams.get('cursor')).toBe('c1');
      expect(page).toEqual({ events: [expect.objectContaining({ txHash: 'tx12' })], nextCursor: 'c2' });
   });

   it('fails on a non-2xx response', async () => {
      const source = createHttpEventSource({
         baseUrl: 'https://worker.example/export',
         fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      });
      await expect(
         source.fetchPage({ contractId: CONTRACT, fromLedger: 10, toLedger: 20, cursor: null, limit: 10 })
      ).rejects.toThrow('HTTP 503');
   });
});

describe('createThrottle', () => {
   it('spaces requests out once the burst is spent', async () => {
      let clock = 0;
      const waits: number[] = [];
      const throttle = createThrottle({
         requestsPerSecond: 10,
         burst: 1,
         now: () => clock,
         sleep: async ms => {
            waits.push(ms);
            clock += ms;
         },
      });

      await throttle.take();
      await throttle.take();
      await throttle.take();

      expect(waits).toEqual([100, 100]);
   });

   it('rejects a non-positive rate', () => {
      expect(() => createThrottle({ requestsPerSecond: 0 })).toThrow('requestsPerSecond');
   });
});
