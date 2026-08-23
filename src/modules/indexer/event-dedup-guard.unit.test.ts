import { processIndexerChainEvents, IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

jest.mock('../../utils/logger.utils', () => ({
   logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn() },
}));

function makeEvent(overrides: Partial<IndexerChainEvent> = {}): IndexerChainEvent {
   return {
      txHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      eventIndex: 0,
      eventType: 'KEY_BOUGHT',
      ledger: 1000,
      ...overrides,
   };
}

describe('event deduplication guard — (txHash, eventIndex) composite key', () => {
   describe('new event pair is processed', () => {
      it('calls the handler exactly once for a new (txHash, eventIndex) pair', async () => {
         const handler = jest.fn().mockResolvedValue(undefined);
         const event = makeEvent({ txHash: '0xaaa', eventIndex: 0 });

         await processIndexerChainEvents([event], handler);

         expect(handler).toHaveBeenCalledTimes(1);
         expect(handler).toHaveBeenCalledWith(event);
      });

      it('inserts the event into the DB on first appearance', async () => {
         const db: { records: IndexerChainEvent[] } = { records: [] };

         const handler = jest.fn().mockImplementation(async (e: IndexerChainEvent) => {
            db.records.push(e);
         });

         await processIndexerChainEvents([makeEvent({ txHash: '0xbbb', eventIndex: 1 })], handler);

         expect(db.records).toHaveLength(1);
         expect(db.records[0].txHash).toBe('0xbbb');
         expect(db.records[0].eventIndex).toBe(1);
      });
   });

   describe('duplicate pair is skipped', () => {
      it('does not call the handler for a duplicate (txHash, eventIndex) in the same batch', async () => {
         const handler = jest.fn().mockResolvedValue(undefined);
         const events: IndexerChainEvent[] = [
            makeEvent({ txHash: '0xccc', eventIndex: 0 }),
            makeEvent({ txHash: '0xccc', eventIndex: 0 }), // exact duplicate
         ];

         await processIndexerChainEvents(events, handler);

         // Guard skips the duplicate — handler called only once
         expect(handler).toHaveBeenCalledTimes(1);
      });

      it('keeps DB event count at 1 after processing a duplicate pair', async () => {
         const db: { records: IndexerChainEvent[] } = { records: [] };
         const handler = jest.fn().mockImplementation(async (e: IndexerChainEvent) => {
            db.records.push(e);
         });

         const events: IndexerChainEvent[] = [
            makeEvent({ txHash: '0xddd', eventIndex: 2 }),
            makeEvent({ txHash: '0xddd', eventIndex: 2 }), // duplicate
         ];

         await processIndexerChainEvents(events, handler);

         expect(db.records).toHaveLength(1);
      });

      it('skips all extra copies when the same event appears three times', async () => {
         const handler = jest.fn().mockResolvedValue(undefined);
         const events: IndexerChainEvent[] = [
            makeEvent({ txHash: '0xeee', eventIndex: 5 }),
            makeEvent({ txHash: '0xeee', eventIndex: 5 }),
            makeEvent({ txHash: '0xeee', eventIndex: 5 }),
         ];

         await processIndexerChainEvents(events, handler);

         expect(handler).toHaveBeenCalledTimes(1);
      });

      it('does not trigger side effects (balance update, price snapshot) on a skipped event', async () => {
         const balanceUpdate = jest.fn();
         const priceSnapshot = jest.fn();

         const handler = jest.fn().mockImplementation(async () => {
            balanceUpdate();
            priceSnapshot();
         });

         const events: IndexerChainEvent[] = [
            makeEvent({ txHash: '0xfff', eventIndex: 0 }),
            makeEvent({ txHash: '0xfff', eventIndex: 0 }), // duplicate — side effects must NOT fire again
         ];

         await processIndexerChainEvents(events, handler);

         expect(balanceUpdate).toHaveBeenCalledTimes(1);
         expect(priceSnapshot).toHaveBeenCalledTimes(1);
      });
   });

   describe('same txHash, different eventIndex are distinct events', () => {
      it('processes both events when txHash is the same but eventIndex differs', async () => {
         const handler = jest.fn().mockResolvedValue(undefined);
         const events: IndexerChainEvent[] = [
            makeEvent({ txHash: '0x111', eventIndex: 0 }),
            makeEvent({ txHash: '0x111', eventIndex: 1 }), // different index → new event
         ];

         await processIndexerChainEvents(events, handler);

         expect(handler).toHaveBeenCalledTimes(2);
         expect(handler).toHaveBeenNthCalledWith(1, expect.objectContaining({ txHash: '0x111', eventIndex: 0 }));
         expect(handler).toHaveBeenNthCalledWith(2, expect.objectContaining({ txHash: '0x111', eventIndex: 1 }));
      });

      it('writes two DB records for same txHash with eventIndex 0 and 1', async () => {
         const db: { records: IndexerChainEvent[] } = { records: [] };
         const handler = jest.fn().mockImplementation(async (e: IndexerChainEvent) => {
            db.records.push(e);
         });

         const events: IndexerChainEvent[] = [
            makeEvent({ txHash: '0x222', eventIndex: 0 }),
            makeEvent({ txHash: '0x222', eventIndex: 1 }),
         ];

         await processIndexerChainEvents(events, handler);

         expect(db.records).toHaveLength(2);
         const indices = db.records.map(r => r.eventIndex).sort();
         expect(indices).toEqual([0, 1]);
      });

      it('treats events with different txHash but same eventIndex as distinct', async () => {
         const handler = jest.fn().mockResolvedValue(undefined);
         const events: IndexerChainEvent[] = [
            makeEvent({ txHash: '0xaaa', eventIndex: 3 }),
            makeEvent({ txHash: '0xbbb', eventIndex: 3 }), // different hash, same index
         ];

         await processIndexerChainEvents(events, handler);

         expect(handler).toHaveBeenCalledTimes(2);
      });
   });

   describe('mixed batches with unique and duplicate events', () => {
      it('processes only unique events from a batch containing both', async () => {
         const handler = jest.fn().mockResolvedValue(undefined);
         const events: IndexerChainEvent[] = [
            makeEvent({ txHash: 'tx1', eventIndex: 0 }),
            makeEvent({ txHash: 'tx2', eventIndex: 0 }),
            makeEvent({ txHash: 'tx1', eventIndex: 0 }), // duplicate of first
            makeEvent({ txHash: 'tx3', eventIndex: 0 }),
            makeEvent({ txHash: 'tx2', eventIndex: 0 }), // duplicate of second
         ];

         await processIndexerChainEvents(events, handler);

         expect(handler).toHaveBeenCalledTimes(3);
      });

      it('preserves first-occurrence order when deduplicating a batch', async () => {
         const processed: string[] = [];
         const handler = jest.fn().mockImplementation(async (e: IndexerChainEvent) => {
            processed.push(`${e.txHash}:${e.eventIndex}`);
         });

         const events: IndexerChainEvent[] = [
            makeEvent({ txHash: 'txZ', eventIndex: 0 }),
            makeEvent({ txHash: 'txA', eventIndex: 0 }),
            makeEvent({ txHash: 'txZ', eventIndex: 0 }), // duplicate
            makeEvent({ txHash: 'txM', eventIndex: 0 }),
         ];

         await processIndexerChainEvents(events, handler);

         expect(processed).toEqual(['txZ:0', 'txA:0', 'txM:0']);
      });

      it('DB count equals the number of unique (txHash, eventIndex) pairs in the batch', async () => {
         const db: { records: IndexerChainEvent[] } = { records: [] };
         const handler = jest.fn().mockImplementation(async (e: IndexerChainEvent) => {
            db.records.push(e);
         });

         const events: IndexerChainEvent[] = [
            makeEvent({ txHash: 'ta', eventIndex: 0 }),
            makeEvent({ txHash: 'ta', eventIndex: 1 }),
            makeEvent({ txHash: 'tb', eventIndex: 0 }),
            makeEvent({ txHash: 'ta', eventIndex: 0 }), // duplicate
            makeEvent({ txHash: 'tb', eventIndex: 0 }), // duplicate
         ];

         await processIndexerChainEvents(events, handler);

         // 5 events in → 3 unique pairs (ta:0, ta:1, tb:0) → 3 DB records
         expect(db.records).toHaveLength(3);
      });
   });

   describe('edge cases', () => {
      it('processes an empty batch without errors', async () => {
         const handler = jest.fn().mockResolvedValue(undefined);

         await expect(processIndexerChainEvents([], handler)).resolves.not.toThrow();
         expect(handler).not.toHaveBeenCalled();
      });

      it('processes a single-event batch correctly', async () => {
         const handler = jest.fn().mockResolvedValue(undefined);
         const event = makeEvent({ txHash: '0xsingle', eventIndex: 0 });

         await processIndexerChainEvents([event], handler);

         expect(handler).toHaveBeenCalledTimes(1);
         expect(handler).toHaveBeenCalledWith(event);
      });

      it('deduplication key is case-sensitive for txHash', async () => {
         const handler = jest.fn().mockResolvedValue(undefined);
         const events: IndexerChainEvent[] = [
            makeEvent({ txHash: '0xABC', eventIndex: 0 }),
            makeEvent({ txHash: '0xabc', eventIndex: 0 }), // different case → treated as different
         ];

         await processIndexerChainEvents(events, handler);

         expect(handler).toHaveBeenCalledTimes(2);
      });

      it('handles eventIndex 0 correctly — does not confuse falsy value with missing key', async () => {
         const handler = jest.fn().mockResolvedValue(undefined);
         const events: IndexerChainEvent[] = [
            makeEvent({ txHash: '0xzero', eventIndex: 0 }),
            makeEvent({ txHash: '0xzero', eventIndex: 0 }), // duplicate with index 0
         ];

         await processIndexerChainEvents(events, handler);

         expect(handler).toHaveBeenCalledTimes(1);
      });

      it('handles large eventIndex values without collision', async () => {
         const handler = jest.fn().mockResolvedValue(undefined);
         const events: IndexerChainEvent[] = [
            makeEvent({ txHash: '0xlarge', eventIndex: 999999999 }),
            makeEvent({ txHash: '0xlarge', eventIndex: 999999999 }), // duplicate
         ];

         await processIndexerChainEvents(events, handler);

         expect(handler).toHaveBeenCalledTimes(1);
      });
   });
});
