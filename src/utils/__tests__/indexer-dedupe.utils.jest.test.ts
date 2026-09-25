/**
 * Unit tests for indexer deduplication logic.
 *
 * Tests confirm that duplicate events (identified by txHash + eventIndex composite key)
 * are detected and discarded without creating duplicate database records or throwing errors.
 *
 * Scope:
 * - First event with a given hash+index is inserted successfully
 * - Second event with the same hash+index is discarded (no duplicate record, no error thrown)
 * - Event with the same hash but different index is treated as a new record
 * - Event with different hash but same index is treated as a new record
 */

import { dedupeChainEvents, ChainEvent } from '../indexer-dedupe.utils';

describe('indexer-dedupe.utils — dedupeChainEvents()', () => {
   describe('composite key deduplication (txHash + eventIndex)', () => {
      it('first event with a given hash+index is included', () => {
         const events: ChainEvent[] = [
            { txHash: 'abc123', eventIndex: 0, ledger: 100 },
         ];

         const deduped = dedupeChainEvents(events);

         expect(deduped).toHaveLength(1);
         expect(deduped[0].txHash).toBe('abc123');
         expect(deduped[0].eventIndex).toBe(0);
      });

      it('second event with the same hash+index is discarded', () => {
         const events: ChainEvent[] = [
            { txHash: 'abc123', eventIndex: 0, ledger: 100 },
            { txHash: 'abc123', eventIndex: 0, ledger: 100 }, // Exact duplicate
         ];

         const deduped = dedupeChainEvents(events);

         expect(deduped).toHaveLength(1);
         expect(deduped[0].txHash).toBe('abc123');
         expect(deduped[0].eventIndex).toBe(0);
      });

      it('multiple duplicates of the same event are all discarded', () => {
         const events: ChainEvent[] = [
            { txHash: 'abc123', eventIndex: 0 },
            { txHash: 'abc123', eventIndex: 0 },
            { txHash: 'abc123', eventIndex: 0 },
            { txHash: 'abc123', eventIndex: 0 },
         ];

         const deduped = dedupeChainEvents(events);

         expect(deduped).toHaveLength(1);
      });

      it('event with the same hash but different index is treated as new', () => {
         const events: ChainEvent[] = [
            { txHash: 'abc123', eventIndex: 0 },
            { txHash: 'abc123', eventIndex: 1 }, // Same hash, different index
         ];

         const deduped = dedupeChainEvents(events);

         expect(deduped).toHaveLength(2);
         expect(deduped[0].eventIndex).toBe(0);
         expect(deduped[1].eventIndex).toBe(1);
      });

      it('event with different hash but same index is treated as new', () => {
         const events: ChainEvent[] = [
            { txHash: 'abc123', eventIndex: 5 },
            { txHash: 'xyz789', eventIndex: 5 }, // Different hash, same index
         ];

         const deduped = dedupeChainEvents(events);

         expect(deduped).toHaveLength(2);
         expect(deduped[0].txHash).toBe('abc123');
         expect(deduped[1].txHash).toBe('xyz789');
      });
   });

   describe('batch deduplication', () => {
      it('dedupes a batch with mixed unique and duplicate events', () => {
         const events: ChainEvent[] = [
            { txHash: 'tx1', eventIndex: 0 },
            { txHash: 'tx2', eventIndex: 0 },
            { txHash: 'tx1', eventIndex: 0 }, // Duplicate
            { txHash: 'tx3', eventIndex: 0 },
            { txHash: 'tx2', eventIndex: 0 }, // Duplicate
            { txHash: 'tx4', eventIndex: 0 },
         ];

         const deduped = dedupeChainEvents(events);

         expect(deduped).toHaveLength(4);
         expect(deduped.map(e => e.txHash)).toEqual([
            'tx1',
            'tx2',
            'tx3',
            'tx4',
         ]);
      });

      it('preserves order of first occurrences', () => {
         const events: ChainEvent[] = [
            { txHash: 'z', eventIndex: 0 },
            { txHash: 'a', eventIndex: 0 },
            { txHash: 'z', eventIndex: 0 }, // Duplicate
            { txHash: 'm', eventIndex: 0 },
            { txHash: 'a', eventIndex: 0 }, // Duplicate
         ];

         const deduped = dedupeChainEvents(events);

         expect(deduped.map(e => e.txHash)).toEqual(['z', 'a', 'm']);
      });
   });

   describe('edge cases', () => {
      it('handles empty event list', () => {
         const events: ChainEvent[] = [];

         const deduped = dedupeChainEvents(events);

         expect(deduped).toHaveLength(0);
      });

      it('preserves all fields from events (not just txHash and eventIndex)', () => {
         const events: ChainEvent[] = [
            {
               txHash: 'tx1',
               eventIndex: 0,
               ledger: 1000,
               someOtherField: 'data',
            },
         ];

         const deduped = dedupeChainEvents(events);

         expect(deduped[0]).toEqual({
            txHash: 'tx1',
            eventIndex: 0,
            ledger: 1000,
            someOtherField: 'data',
         });
      });

      it('keeps first occurrence when same event appears twice with different extra fields', () => {
         const events: ChainEvent[] = [
            { txHash: 'tx1', eventIndex: 0, metadata: 'first' },
            { txHash: 'tx1', eventIndex: 0, metadata: 'second' },
         ];

         const deduped = dedupeChainEvents(events);

         expect(deduped).toHaveLength(1);
         expect(deduped[0].metadata).toBe('first');
      });

      it('handles events with eventIndex 0', () => {
         const events: ChainEvent[] = [
            { txHash: 'tx1', eventIndex: 0 },
            { txHash: 'tx1', eventIndex: 0 },
         ];

         const deduped = dedupeChainEvents(events);

         expect(deduped).toHaveLength(1);
      });

      it('handles large eventIndex values', () => {
         const events: ChainEvent[] = [
            { txHash: 'tx1', eventIndex: 999999999 },
            { txHash: 'tx1', eventIndex: 999999999 },
         ];

         const deduped = dedupeChainEvents(events);

         expect(deduped).toHaveLength(1);
      });

      it('composite key is case-sensitive for txHash', () => {
         const events: ChainEvent[] = [
            { txHash: 'ABC123', eventIndex: 0 },
            { txHash: 'abc123', eventIndex: 0 }, // Different case
         ];

         const deduped = dedupeChainEvents(events);

         // Different case means different txHash, so both are kept
         expect(deduped).toHaveLength(2);
      });

      it('does not throw error on duplicate event', () => {
         const events: ChainEvent[] = [
            { txHash: 'tx1', eventIndex: 0 },
            { txHash: 'tx1', eventIndex: 0 },
         ];

         expect(() => {
            dedupeChainEvents(events);
         }).not.toThrow();
      });
   });

   describe('correctness of composite key', () => {
      it('the composite key is specifically txHash:eventIndex (not just one field)', () => {
         // This test verifies that deduplication uses BOTH fields
         const events: ChainEvent[] = [
            { txHash: 'tx1', eventIndex: 1 },
            { txHash: 'tx2', eventIndex: 1 },
            { txHash: 'tx1', eventIndex: 2 },
            { txHash: 'tx1', eventIndex: 1 }, // Only this one is a duplicate
         ];

         const deduped = dedupeChainEvents(events);

         expect(deduped).toHaveLength(3);
         const ids = deduped.map(e => `${e.txHash}:${e.eventIndex}`);
         expect(ids).toEqual(['tx1:1', 'tx2:1', 'tx1:2']);
      });
   });

   describe('returns new array (immutability)', () => {
      it('returns a new array instance', () => {
         const events: ChainEvent[] = [{ txHash: 'tx1', eventIndex: 0 }];

         const deduped = dedupeChainEvents(events);

         expect(deduped).not.toBe(events);
      });

      it('does not mutate the input array', () => {
         const events: ChainEvent[] = [
            { txHash: 'tx1', eventIndex: 0 },
            { txHash: 'tx1', eventIndex: 0 },
         ];
         const original = [...events];

         dedupeChainEvents(events);

         expect(events).toEqual(original);
      });
   });
});
