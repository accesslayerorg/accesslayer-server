import { logger } from './logger.utils';
import {
   getChainEventId,
   processIndexerChainEvent,
   processIndexerChainEvents,
   IndexerChainEvent,
} from './indexer-event-processor.utils';

jest.mock('./logger.utils', () => ({
   logger: {
      info: jest.fn(),
      debug: jest.fn(),
   },
}));

const infoMock = logger.info as jest.Mock;
const debugMock = logger.debug as jest.Mock;

function makeEvent(
   overrides: Partial<IndexerChainEvent> = {}
): IndexerChainEvent {
   return {
      txHash: '0xabc123',
      eventIndex: 0,
      eventType: 'CREATOR_REGISTERED',
      ...overrides,
   };
}

describe('indexer-event-processor.utils', () => {
   beforeEach(() => {
      infoMock.mockClear();
      debugMock.mockClear();
   });

   describe('getChainEventId', () => {
      it('combines txHash and eventIndex', () => {
         expect(
            getChainEventId(makeEvent({ txHash: '0xdead', eventIndex: 3 }))
         ).toBe('0xdead:3');
      });
   });

   describe('processIndexerChainEvent', () => {
      it('emits one structured log after the handler completes', async () => {
         const event = makeEvent();
         const handler = jest.fn().mockResolvedValue(undefined);

         await processIndexerChainEvent(event, handler);

         expect(handler).toHaveBeenCalledWith(event);
         expect(infoMock).toHaveBeenCalledTimes(1);
         expect(infoMock).toHaveBeenCalledWith(
            expect.objectContaining({
               type: 'indexer_event_processed',
               event_type: 'CREATOR_REGISTERED',
               event_id: '0xabc123:0',
               tx_hash: '0xabc123',
               event_index: 0,
               elapsed_ms: expect.any(Number),
            }),
            'Indexer chain event processed'
         );
      });

      it('does not emit a log when the handler throws', async () => {
         const handler = jest
            .fn()
            .mockRejectedValue(new Error('handler failed'));

         await expect(
            processIndexerChainEvent(makeEvent(), handler)
         ).rejects.toThrow('handler failed');

         expect(infoMock).not.toHaveBeenCalled();
      });
   });

   describe('processIndexerChainEvents', () => {
      it('dedupes events and logs once per unique event', async () => {
         const events: IndexerChainEvent[] = [
            makeEvent({
               txHash: '0x1',
               eventIndex: 0,
               eventType: 'KEY_BOUGHT',
            }),
            makeEvent({
               txHash: '0x1',
               eventIndex: 0,
               eventType: 'KEY_BOUGHT',
            }),
            makeEvent({ txHash: '0x1', eventIndex: 1, eventType: 'KEY_SOLD' }),
         ];
         const handler = jest.fn().mockResolvedValue(undefined);

         await processIndexerChainEvents(events, handler);

         expect(handler).toHaveBeenCalledTimes(2);
         // 1 batch-start log + 2 per-event logs
         expect(infoMock).toHaveBeenCalledTimes(3);
      });

      it('emits an info-level batch-start log with the ledger range and raw batch size', async () => {
         const events: IndexerChainEvent[] = [
            makeEvent({ txHash: '0x1', eventIndex: 0, ledger: 105 }),
            makeEvent({ txHash: '0x1', eventIndex: 0, ledger: 105 }), // duplicate
            makeEvent({ txHash: '0x2', eventIndex: 0, ledger: 110 }),
         ];
         const handler = jest.fn().mockResolvedValue(undefined);

         await processIndexerChainEvents(events, handler);

         expect(infoMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
               type: 'indexer_batch_started',
               from_ledger: 105,
               to_ledger: 110,
               batch_size: 3, // size before dedup
            }),
            'Indexer batch started'
         );
      });

      it('emits a debug-level batch-completion log with events processed and duration', async () => {
         const events: IndexerChainEvent[] = [
            makeEvent({ txHash: '0x1', eventIndex: 0, ledger: 105 }),
            makeEvent({ txHash: '0x1', eventIndex: 0, ledger: 105 }), // duplicate
            makeEvent({ txHash: '0x2', eventIndex: 0, ledger: 110 }),
         ];
         const handler = jest.fn().mockResolvedValue(undefined);

         await processIndexerChainEvents(events, handler);

         expect(debugMock).toHaveBeenCalledTimes(1);
         expect(debugMock).toHaveBeenCalledWith(
            expect.objectContaining({
               type: 'indexer_batch_completed',
               from_ledger: 105,
               to_ledger: 110,
               events_processed: 2, // unique events after dedup
               duration_ms: expect.any(Number),
            }),
            'Indexer batch completed'
         );
      });

      it('emits exactly one batch-start and one batch-completion log regardless of batch size', async () => {
         const events: IndexerChainEvent[] = [
            makeEvent({ txHash: '0x1', eventIndex: 0, ledger: 1 }),
            makeEvent({ txHash: '0x2', eventIndex: 0, ledger: 2 }),
            makeEvent({ txHash: '0x3', eventIndex: 0, ledger: 3 }),
         ];
         const handler = jest.fn().mockResolvedValue(undefined);

         await processIndexerChainEvents(events, handler);

         // 1 batch-start + 3 per-event info logs
         expect(infoMock).toHaveBeenCalledTimes(4);
         expect(debugMock).toHaveBeenCalledTimes(1);
      });

      it('handles a batch with no ledger values by omitting the range', async () => {
         const events: IndexerChainEvent[] = [
            makeEvent({ txHash: '0x1', eventIndex: 0, ledger: undefined }),
         ];
         const handler = jest.fn().mockResolvedValue(undefined);

         await processIndexerChainEvents(events, handler);

         expect(infoMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
               type: 'indexer_batch_started',
               from_ledger: undefined,
               to_ledger: undefined,
               batch_size: 1,
            }),
            'Indexer batch started'
         );
      });
   });
});
