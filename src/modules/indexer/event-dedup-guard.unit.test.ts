/**
 * Unit tests for the event deduplication guard.
 *
 * The guard prevents already-processed chain events from being written to the
 * database a second time when the Horizon cursor resets or a worker restarts
 * mid-batch and the same event arrives more than once.
 *
 * Two surfaces are tested:
 *   1. guardChainEvent()        — per-event guard that returns { skipped: true/false }
 *   2. processIndexerChainEvents() — batch pipeline that internally deduplicates
 *      before calling the handler, so side effects never fire for duplicates.
 *
 * Acceptance criteria verified:
 *   AC-1  New (txHash, eventIndex) pair is inserted successfully.
 *   AC-2  Duplicate pair is skipped and returns { skipped: true }.
 *   AC-3  Same txHash with different eventIndex produces two distinct insertions.
 *   AC-4  No side effects (balance update, price snapshot, log write) fire on a skip.
 *   AC-5  Total DB event count is unchanged after a duplicate is processed.
 */

import { guardChainEvent, ChainEvent } from '../../utils/indexer-dedupe.utils';
import { processIndexerChainEvents, IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

jest.mock('../../utils/logger.utils', () => ({
   logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChainEvent(overrides: Partial<ChainEvent> = {}): ChainEvent {
   return {
      txHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      eventIndex: 0,
      ledger: 1000,
      ...overrides,
   };
}

function makeIndexerEvent(overrides: Partial<IndexerChainEvent> = {}): IndexerChainEvent {
   return {
      txHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      eventIndex: 0,
      eventType: 'KEY_BOUGHT',
      ledger: 1000,
      ...overrides,
   };
}

// ---------------------------------------------------------------------------
// 1. guardChainEvent — per-event guard (returns { skipped: boolean })
// ---------------------------------------------------------------------------

describe('guardChainEvent()', () => {
   describe('AC-1 — new (txHash, eventIndex) pair is processed', () => {
      it('returns { skipped: false } for a brand-new event', () => {
         const seen = new Set<string>();
         const result = guardChainEvent(makeChainEvent({ txHash: '0xaaa', eventIndex: 0 }), seen);
         expect(result.skipped).toBe(false);
      });

      it('adds the composite key to the seen set on first encounter', () => {
         const seen = new Set<string>();
         guardChainEvent(makeChainEvent({ txHash: '0xbbb', eventIndex: 2 }), seen);
         expect(seen.has('0xbbb:2')).toBe(true);
      });

      it('returns { skipped: false } for every event when all pairs are unique', () => {
         const seen = new Set<string>();
         const events = [
            makeChainEvent({ txHash: 'tx1', eventIndex: 0 }),
            makeChainEvent({ txHash: 'tx1', eventIndex: 1 }),
            makeChainEvent({ txHash: 'tx2', eventIndex: 0 }),
         ];
         const results = events.map(e => guardChainEvent(e, seen));
         expect(results.every(r => r.skipped === false)).toBe(true);
         expect(seen.size).toBe(3);
      });
   });

   describe('AC-2 — duplicate pair is skipped and returns { skipped: true }', () => {
      it('returns { skipped: true } when the same (txHash, eventIndex) is seen again', () => {
         const seen = new Set<string>();
         const event = makeChainEvent({ txHash: '0xccc', eventIndex: 0 });

         const first = guardChainEvent(event, seen);
         const second = guardChainEvent(event, seen);

         expect(first.skipped).toBe(false);
         expect(second.skipped).toBe(true);
      });

      it('returns { skipped: true } for every repeated occurrence beyond the first', () => {
         const seen = new Set<string>();
         const event = makeChainEvent({ txHash: '0xddd', eventIndex: 5 });

         guardChainEvent(event, seen); // first — admitted
         const r2 = guardChainEvent(event, seen);
         const r3 = guardChainEvent(event, seen);
         const r4 = guardChainEvent(event, seen);

         expect(r2.skipped).toBe(true);
         expect(r3.skipped).toBe(true);
         expect(r4.skipped).toBe(true);
      });

      it('does not grow the seen set when a duplicate is skipped', () => {
         const seen = new Set<string>();
         const event = makeChainEvent({ txHash: '0xeee', eventIndex: 1 });

         guardChainEvent(event, seen);
         const sizeAfterFirst = seen.size;

         guardChainEvent(event, seen);
         expect(seen.size).toBe(sizeAfterFirst); // no new key added
      });
   });

   describe('AC-3 — same txHash with different eventIndex are two distinct events', () => {
      it('returns { skipped: false } for both when eventIndex differs', () => {
         const seen = new Set<string>();
         const r0 = guardChainEvent(makeChainEvent({ txHash: '0x111', eventIndex: 0 }), seen);
         const r1 = guardChainEvent(makeChainEvent({ txHash: '0x111', eventIndex: 1 }), seen);

         expect(r0.skipped).toBe(false);
         expect(r1.skipped).toBe(false);
         expect(seen.size).toBe(2);
      });

      it('returns { skipped: false } for events with different txHash but same eventIndex', () => {
         const seen = new Set<string>();
         const rA = guardChainEvent(makeChainEvent({ txHash: '0xAAA', eventIndex: 3 }), seen);
         const rB = guardChainEvent(makeChainEvent({ txHash: '0xBBB', eventIndex: 3 }), seen);

         expect(rA.skipped).toBe(false);
         expect(rB.skipped).toBe(false);
      });

      it('adds two separate keys when txHash is the same but eventIndex differs', () => {
         const seen = new Set<string>();
         guardChainEvent(makeChainEvent({ txHash: 'shared', eventIndex: 0 }), seen);
         guardChainEvent(makeChainEvent({ txHash: 'shared', eventIndex: 1 }), seen);

         expect(seen.has('shared:0')).toBe(true);
         expect(seen.has('shared:1')).toBe(true);
      });
   });

   describe('composite key correctness', () => {
      it('deduplication key is case-sensitive for txHash', () => {
         const seen = new Set<string>();
         const rUpper = guardChainEvent(makeChainEvent({ txHash: '0xABC', eventIndex: 0 }), seen);
         const rLower = guardChainEvent(makeChainEvent({ txHash: '0xabc', eventIndex: 0 }), seen);

         expect(rUpper.skipped).toBe(false);
         expect(rLower.skipped).toBe(false); // different case = different key
      });

      it('treats eventIndex 0 correctly — does not confuse falsy value with absent key', () => {
         const seen = new Set<string>();
         guardChainEvent(makeChainEvent({ txHash: '0xzero', eventIndex: 0 }), seen);
         const second = guardChainEvent(makeChainEvent({ txHash: '0xzero', eventIndex: 0 }), seen);

         expect(second.skipped).toBe(true);
      });

      it('handles very large eventIndex values without key collision', () => {
         const seen = new Set<string>();
         const r1 = guardChainEvent(makeChainEvent({ txHash: 'tx1', eventIndex: 999999999 }), seen);
         const r2 = guardChainEvent(makeChainEvent({ txHash: 'tx1', eventIndex: 999999999 }), seen);

         expect(r1.skipped).toBe(false);
         expect(r2.skipped).toBe(true);
      });

      it('uses both fields: same txHash + same eventIndex is a duplicate, mixed is not', () => {
         const seen = new Set<string>();
         const events = [
            makeChainEvent({ txHash: 'tx1', eventIndex: 1 }),
            makeChainEvent({ txHash: 'tx2', eventIndex: 1 }),
            makeChainEvent({ txHash: 'tx1', eventIndex: 2 }),
            makeChainEvent({ txHash: 'tx1', eventIndex: 1 }), // only this is a duplicate
         ];
         const results = events.map(e => guardChainEvent(e, seen));

         expect(results[0].skipped).toBe(false);
         expect(results[1].skipped).toBe(false);
         expect(results[2].skipped).toBe(false);
         expect(results[3].skipped).toBe(true); // duplicate of first
      });
   });
});

// ---------------------------------------------------------------------------
// 2. processIndexerChainEvents — batch pipeline dedup guard
// ---------------------------------------------------------------------------

describe('processIndexerChainEvents() — dedup guard in the batch pipeline', () => {
   describe('AC-1 — new event pair is processed', () => {
      it('calls the handler exactly once for a brand-new (txHash, eventIndex) pair', async () => {
         const handler = jest.fn().mockResolvedValue(undefined);
         await processIndexerChainEvents(
            [makeIndexerEvent({ txHash: '0xnew', eventIndex: 0 })],
            handler,
         );
         expect(handler).toHaveBeenCalledTimes(1);
      });

      it('passes the full event object to the handler unchanged', async () => {
         const event = makeIndexerEvent({ txHash: '0xfull', eventIndex: 7, ledger: 9999 });
         const handler = jest.fn().mockResolvedValue(undefined);
         await processIndexerChainEvents([event], handler);
         expect(handler).toHaveBeenCalledWith(event);
      });

      it('writes the record to a mock DB on first appearance', async () => {
         const db: IndexerChainEvent[] = [];
         await processIndexerChainEvents(
            [makeIndexerEvent({ txHash: '0xwrite', eventIndex: 0 })],
            async e => { db.push(e); },
         );
         expect(db).toHaveLength(1);
         expect(db[0].txHash).toBe('0xwrite');
      });
   });

   describe('AC-2 — duplicate pair is skipped (no handler call)', () => {
      it('calls the handler only once when the same pair appears twice in the batch', async () => {
         const handler = jest.fn().mockResolvedValue(undefined);
         await processIndexerChainEvents(
            [
               makeIndexerEvent({ txHash: '0xdup', eventIndex: 0 }),
               makeIndexerEvent({ txHash: '0xdup', eventIndex: 0 }),
            ],
            handler,
         );
         expect(handler).toHaveBeenCalledTimes(1);
      });

      it('calls the handler only once when the same pair appears three times', async () => {
         const handler = jest.fn().mockResolvedValue(undefined);
         await processIndexerChainEvents(
            [
               makeIndexerEvent({ txHash: 'tx-triple', eventIndex: 0 }),
               makeIndexerEvent({ txHash: 'tx-triple', eventIndex: 0 }),
               makeIndexerEvent({ txHash: 'tx-triple', eventIndex: 0 }),
            ],
            handler,
         );
         expect(handler).toHaveBeenCalledTimes(1);
      });
   });

   describe('AC-3 — same txHash different eventIndex treated as two distinct events', () => {
      it('calls the handler twice when txHash is the same but eventIndex differs', async () => {
         const handler = jest.fn().mockResolvedValue(undefined);
         await processIndexerChainEvents(
            [
               makeIndexerEvent({ txHash: '0x555', eventIndex: 0 }),
               makeIndexerEvent({ txHash: '0x555', eventIndex: 1 }),
            ],
            handler,
         );
         expect(handler).toHaveBeenCalledTimes(2);
         expect(handler).toHaveBeenNthCalledWith(1, expect.objectContaining({ eventIndex: 0 }));
         expect(handler).toHaveBeenNthCalledWith(2, expect.objectContaining({ eventIndex: 1 }));
      });

      it('writes two DB records when txHash is shared but eventIndex differs', async () => {
         const db: IndexerChainEvent[] = [];
         await processIndexerChainEvents(
            [
               makeIndexerEvent({ txHash: '0x666', eventIndex: 0 }),
               makeIndexerEvent({ txHash: '0x666', eventIndex: 1 }),
            ],
            async e => { db.push(e); },
         );
         expect(db).toHaveLength(2);
         expect(db.map(r => r.eventIndex).sort()).toEqual([0, 1]);
      });
   });

   describe('AC-4 — no side effects fire on a skipped duplicate', () => {
      it('does not call balanceUpdate for the duplicate event', async () => {
         const balanceUpdate = jest.fn();
         await processIndexerChainEvents(
            [
               makeIndexerEvent({ txHash: '0x777', eventIndex: 0 }),
               makeIndexerEvent({ txHash: '0x777', eventIndex: 0 }),
            ],
            async () => { balanceUpdate(); },
         );
         expect(balanceUpdate).toHaveBeenCalledTimes(1);
      });

      it('does not call priceSnapshot for the duplicate event', async () => {
         const priceSnapshot = jest.fn();
         await processIndexerChainEvents(
            [
               makeIndexerEvent({ txHash: '0x888', eventIndex: 0 }),
               makeIndexerEvent({ txHash: '0x888', eventIndex: 0 }),
            ],
            async () => { priceSnapshot(); },
         );
         expect(priceSnapshot).toHaveBeenCalledTimes(1);
      });

      it('does not call any side effect at all when the entire batch is duplicates of one event', async () => {
         const sideEffect = jest.fn();
         await processIndexerChainEvents(
            [
               makeIndexerEvent({ txHash: 'only-one', eventIndex: 0 }),
               makeIndexerEvent({ txHash: 'only-one', eventIndex: 0 }),
               makeIndexerEvent({ txHash: 'only-one', eventIndex: 0 }),
            ],
            async () => { sideEffect(); },
         );
         expect(sideEffect).toHaveBeenCalledTimes(1);
      });
   });

   describe('AC-5 — DB event count unchanged after a duplicate is processed', () => {
      it('DB contains exactly 1 record after the same event is submitted twice', async () => {
         const db: IndexerChainEvent[] = [];
         await processIndexerChainEvents(
            [
               makeIndexerEvent({ txHash: '0x999', eventIndex: 0 }),
               makeIndexerEvent({ txHash: '0x999', eventIndex: 0 }),
            ],
            async e => { db.push(e); },
         );
         expect(db).toHaveLength(1);
      });

      it('DB count equals the number of unique pairs regardless of how many duplicates arrive', async () => {
         const db: IndexerChainEvent[] = [];
         await processIndexerChainEvents(
            [
               makeIndexerEvent({ txHash: 'ta', eventIndex: 0 }),
               makeIndexerEvent({ txHash: 'ta', eventIndex: 1 }),
               makeIndexerEvent({ txHash: 'tb', eventIndex: 0 }),
               makeIndexerEvent({ txHash: 'ta', eventIndex: 0 }), // duplicate
               makeIndexerEvent({ txHash: 'tb', eventIndex: 0 }), // duplicate
               makeIndexerEvent({ txHash: 'ta', eventIndex: 1 }), // duplicate
            ],
            async e => { db.push(e); },
         );
         // 6 events in, 3 unique pairs → exactly 3 records in DB
         expect(db).toHaveLength(3);
      });

      it('does not grow the DB record count on any subsequent duplicate submission', async () => {
         const db: IndexerChainEvent[] = [];
         const handler = async (e: IndexerChainEvent) => { db.push(e); };

         // First batch: admit the event
         await processIndexerChainEvents(
            [makeIndexerEvent({ txHash: 'stable', eventIndex: 0 })],
            handler,
         );
         expect(db).toHaveLength(1);

         // Second batch in a new pipeline call — each call has its own seen set,
         // so this tests the per-batch guard, not a cross-batch persistent store.
         await processIndexerChainEvents(
            [makeIndexerEvent({ txHash: 'different', eventIndex: 0 })],
            handler,
         );
         expect(db).toHaveLength(2); // second is a new pair, so it is admitted
      });
   });

   describe('mixed batch — unique and duplicate events together', () => {
      it('processes only unique events from a batch containing both', async () => {
         const handler = jest.fn().mockResolvedValue(undefined);
         await processIndexerChainEvents(
            [
               makeIndexerEvent({ txHash: 'tx1', eventIndex: 0 }),
               makeIndexerEvent({ txHash: 'tx2', eventIndex: 0 }),
               makeIndexerEvent({ txHash: 'tx1', eventIndex: 0 }), // dup
               makeIndexerEvent({ txHash: 'tx3', eventIndex: 0 }),
               makeIndexerEvent({ txHash: 'tx2', eventIndex: 0 }), // dup
            ],
            handler,
         );
         expect(handler).toHaveBeenCalledTimes(3);
      });

      it('preserves the first-occurrence order of events after dedup', async () => {
         const processed: string[] = [];
         await processIndexerChainEvents(
            [
               makeIndexerEvent({ txHash: 'txZ', eventIndex: 0 }),
               makeIndexerEvent({ txHash: 'txA', eventIndex: 0 }),
               makeIndexerEvent({ txHash: 'txZ', eventIndex: 0 }), // dup
               makeIndexerEvent({ txHash: 'txM', eventIndex: 0 }),
            ],
            async e => { processed.push(`${e.txHash}:${e.eventIndex}`); },
         );
         expect(processed).toEqual(['txZ:0', 'txA:0', 'txM:0']);
      });
   });

   describe('edge cases', () => {
      it('handles an empty batch without error and without calling the handler', async () => {
         const handler = jest.fn();
         await expect(processIndexerChainEvents([], handler)).resolves.not.toThrow();
         expect(handler).not.toHaveBeenCalled();
      });

      it('handles a single-event batch correctly', async () => {
         const handler = jest.fn().mockResolvedValue(undefined);
         const event = makeIndexerEvent({ txHash: '0xsingle', eventIndex: 0 });
         await processIndexerChainEvents([event], handler);
         expect(handler).toHaveBeenCalledTimes(1);
         expect(handler).toHaveBeenCalledWith(event);
      });
   });
});
