import {
  parseStellarTradeEvent,
  RawSorobanEvent,
  TradeEvent,
  ParseError,
} from './stellar-trade-event-parser.utils';

function makeRawEvent(
  overrides: Partial<RawSorobanEvent> = {}
): RawSorobanEvent {
  return {
    ledger: 12345,
    ledgerClosedAt: '2026-06-27T12:00:00.000Z',
    topic: ['KEY_BOUGHT', 'creator-abc', 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    data: JSON.stringify({ amount: '100', price: '50', fee: '1' }),
    ...overrides,
  };
}

describe('parseStellarTradeEvent', () => {
  describe('valid events', () => {
    it('maps a valid buy event to the correct schema fields', () => {
      const raw = makeRawEvent({
        topic: ['KEY_BOUGHT', 'creator-abc', 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA'],
        data: JSON.stringify({ amount: '250', price: '75', fee: '2.5' }),
      });

      const result = parseStellarTradeEvent(raw);

      expect(result).toEqual<TradeEvent>({
        event_type: 'buy',
        creator_id: 'creator-abc',
        actor_address: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA',
        amount: '250',
        price: '75',
        fee: '2.5',
        ledger_sequence: 12345,
        timestamp: '2026-06-27T12:00:00.000Z',
      });
    });

    it('maps a valid sell event to the correct schema fields', () => {
      const raw = makeRawEvent({
        topic: ['KEY_SOLD', 'creator-xyz', 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA'],
        data: JSON.stringify({ amount: '50', price: '30', fee: '0.5' }),
        ledger: 99999,
        ledgerClosedAt: '2026-06-28T08:00:00.000Z',
      });

      const result = parseStellarTradeEvent(raw);

      expect(result).toEqual<TradeEvent>({
        event_type: 'sell',
        creator_id: 'creator-xyz',
        actor_address: 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA',
        amount: '50',
        price: '30',
        fee: '0.5',
        ledger_sequence: 99999,
        timestamp: '2026-06-28T08:00:00.000Z',
      });
    });
  });

  describe('error handling', () => {
    it('throws ParseError when a required topic field is missing', () => {
      const raw = makeRawEvent({ topic: [] });

      expect(() => parseStellarTradeEvent(raw)).toThrow(ParseError);
    });

    it('throws ParseError when topic has fewer than 3 segments', () => {
      const raw = makeRawEvent({ topic: ['KEY_BOUGHT', 'creator-abc'] });

      expect(() => parseStellarTradeEvent(raw)).toThrow(ParseError);
    });

    it('throws ParseError for an unknown event type', () => {
      const raw = makeRawEvent({ topic: ['UNKNOWN_EVENT', 'creator-abc', 'GABCDEFGH'] });

      expect(() => parseStellarTradeEvent(raw)).toThrow(ParseError);
    });

    it('throws ParseError when an empty string is used for creator_id', () => {
      const raw = makeRawEvent({ topic: ['KEY_BOUGHT', '', 'GABCDEFGH'] });

      expect(() => parseStellarTradeEvent(raw)).toThrow(ParseError);
    });

    it('throws ParseError when a required field in data is missing', () => {
      const raw = makeRawEvent({
        data: JSON.stringify({ amount: '100', price: '50' }),
      });

      expect(() => parseStellarTradeEvent(raw)).toThrow(ParseError);
    });

    it('throws ParseError when data is not valid JSON', () => {
      const raw = makeRawEvent({ data: 'not-json' });

      expect(() => parseStellarTradeEvent(raw)).toThrow(ParseError);
    });

    it('throws ParseError when ledger is not a number', () => {
      const raw = makeRawEvent({ ledger: NaN });

      expect(() => parseStellarTradeEvent(raw)).toThrow(ParseError);
    });

    it('throws ParseError when ledgerClosedAt is empty', () => {
      const raw = makeRawEvent({ ledgerClosedAt: '' });

      expect(() => parseStellarTradeEvent(raw)).toThrow(ParseError);
    });
  });
});
