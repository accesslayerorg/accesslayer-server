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
  },
}));

const infoMock = logger.info as jest.Mock;

function makeEvent(overrides: Partial<IndexerChainEvent> = {}): IndexerChainEvent {
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
  });

  describe('getChainEventId', () => {
    it('combines txHash and eventIndex', () => {
      expect(getChainEventId(makeEvent({ txHash: '0xdead', eventIndex: 3 }))).toBe(
        '0xdead:3'
      );
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
          eventType: 'CREATOR_REGISTERED',
          eventId: '0xabc123:0',
          txHash: '0xabc123',
          eventIndex: 0,
          elapsedMs: expect.any(Number),
        }),
        'Indexer chain event processed'
      );
    });

    it('does not emit a log when the handler throws', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('handler failed'));

      await expect(
        processIndexerChainEvent(makeEvent(), handler)
      ).rejects.toThrow('handler failed');

      expect(infoMock).not.toHaveBeenCalled();
    });
  });

  describe('processIndexerChainEvents', () => {
    it('dedupes events and logs once per unique event', async () => {
      const events: IndexerChainEvent[] = [
        makeEvent({ txHash: '0x1', eventIndex: 0, eventType: 'KEY_BOUGHT' }),
        makeEvent({ txHash: '0x1', eventIndex: 0, eventType: 'KEY_BOUGHT' }),
        makeEvent({ txHash: '0x1', eventIndex: 1, eventType: 'KEY_SOLD' }),
      ];
      const handler = jest.fn().mockResolvedValue(undefined);

      await processIndexerChainEvents(events, handler);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(infoMock).toHaveBeenCalledTimes(2);
    });
  });
});
