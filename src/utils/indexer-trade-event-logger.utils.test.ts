import { logIndexerTradeEvent, IndexerTradeEventLogFields } from './indexer-trade-event-logger.utils';
import { logger } from './logger.utils';

jest.mock('./logger.utils', () => ({
  logger: { info: jest.fn() },
}));

const infoMock = logger.info as jest.Mock;

const BASE_FIELDS: IndexerTradeEventLogFields = {
  event_type: 'buy',
  creator_id: 'creator-xyz',
  ledger_sequence: 12345,
  actor_address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  amount: '5',
  processed_at: new Date('2026-06-26T10:00:00Z'),
};

describe('logIndexerTradeEvent', () => {
  beforeEach(() => infoMock.mockClear());

  it('emits exactly one structured info log', () => {
    logIndexerTradeEvent(BASE_FIELDS);
    expect(infoMock).toHaveBeenCalledTimes(1);
  });

  it('includes all required fields in the log object', () => {
    logIndexerTradeEvent(BASE_FIELDS);
    const [logObj] = infoMock.mock.calls[0];
    expect(logObj).toHaveProperty('event_type');
    expect(logObj).toHaveProperty('creator_id');
    expect(logObj).toHaveProperty('ledger_sequence');
    expect(logObj).toHaveProperty('actor_address');
    expect(logObj).toHaveProperty('amount');
    expect(logObj).toHaveProperty('processed_at');
  });

  it('logs event_type correctly for a buy event', () => {
    logIndexerTradeEvent({ ...BASE_FIELDS, event_type: 'buy' });
    expect(infoMock.mock.calls[0][0].event_type).toBe('buy');
  });

  it('logs event_type correctly for a sell event', () => {
    logIndexerTradeEvent({ ...BASE_FIELDS, event_type: 'sell' });
    expect(infoMock.mock.calls[0][0].event_type).toBe('sell');
  });

  it('logs creator_id correctly', () => {
    logIndexerTradeEvent({ ...BASE_FIELDS, creator_id: 'creator-abc' });
    expect(infoMock.mock.calls[0][0].creator_id).toBe('creator-abc');
  });

  it('logs ledger_sequence correctly', () => {
    logIndexerTradeEvent({ ...BASE_FIELDS, ledger_sequence: 99999 });
    expect(infoMock.mock.calls[0][0].ledger_sequence).toBe(99999);
  });

  it('masks actor_address to first 4 and last 4 characters', () => {
    logIndexerTradeEvent(BASE_FIELDS);
    const addr = infoMock.mock.calls[0][0].actor_address as string;
    expect(addr).toMatch(/^GAAA\.\.\.AAAA$/);
  });

  it('masks short addresses without truncating', () => {
    logIndexerTradeEvent({ ...BASE_FIELDS, actor_address: 'ABCDEFGH' });
    expect(infoMock.mock.calls[0][0].actor_address).toBe('ABCDEFGH');
  });

  it('masks a different address correctly (first 4 + last 4)', () => {
    logIndexerTradeEvent({ ...BASE_FIELDS, actor_address: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA' });
    const addr = infoMock.mock.calls[0][0].actor_address as string;
    expect(addr.startsWith('GBBB')).toBe(true);
    expect(addr.endsWith('BBBA')).toBe(true);
    expect(addr).toContain('...');
  });

  it('does not log the full actor_address in clear text', () => {
    const fullAddress = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    logIndexerTradeEvent({ ...BASE_FIELDS, actor_address: fullAddress });
    const addr = infoMock.mock.calls[0][0].actor_address as string;
    expect(addr).not.toBe(fullAddress);
    expect(addr.length).toBeLessThan(fullAddress.length);
  });

  it('logs processed_at as an ISO string', () => {
    const ts = new Date('2026-06-26T10:00:00Z');
    logIndexerTradeEvent({ ...BASE_FIELDS, processed_at: ts });
    expect(infoMock.mock.calls[0][0].processed_at).toBe('2026-06-26T10:00:00.000Z');
  });

  it('logs amount correctly', () => {
    logIndexerTradeEvent({ ...BASE_FIELDS, amount: '42' });
    expect(infoMock.mock.calls[0][0].amount).toBe('42');
  });
});
