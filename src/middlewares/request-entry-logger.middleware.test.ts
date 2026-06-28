import { requestEntryLoggerMiddleware } from './request-entry-logger.middleware';
import { logger } from '../utils/logger.utils';

jest.mock('../utils/logger.utils', () => ({
  logger: { info: jest.fn() },
}));

function makeReq(overrides: Record<string, unknown> = {}): any {
  return {
    method: 'GET',
    path: '/api/v1/health',
    requestId: 'test-request-id',
    ip: '203.0.113.42',
    headers: { 'user-agent': 'jest-test-agent' },
    socket: { remoteAddress: '203.0.113.42' },
    ...overrides,
  };
}

function makeRes(): any {
  return {};
}

describe('requestEntryLoggerMiddleware', () => {
  beforeEach(() => jest.clearAllMocks());

  it('emits a log before calling next', () => {
    const next = jest.fn();
    requestEntryLoggerMiddleware(makeReq(), makeRes(), next);
    expect((logger.info as jest.Mock).mock.calls.length).toBe(1);
    expect(next).toHaveBeenCalled();
    const callOrder = (logger.info as jest.Mock).mock.invocationCallOrder[0];
    const nextOrder = (next as jest.Mock).mock.invocationCallOrder[0];
    expect(callOrder).toBeLessThan(nextOrder);
  });

  it('includes all five required fields', () => {
    requestEntryLoggerMiddleware(makeReq(), makeRes(), jest.fn());
    const log = (logger.info as jest.Mock).mock.calls[0][0];
    expect(log).toHaveProperty('request_id');
    expect(log).toHaveProperty('method');
    expect(log).toHaveProperty('path');
    expect(log).toHaveProperty('ip');
    expect(log).toHaveProperty('user_agent');
  });

  it('uses req.requestId as request_id when present', () => {
    requestEntryLoggerMiddleware(makeReq({ requestId: 'my-trace-id' }), makeRes(), jest.fn());
    const log = (logger.info as jest.Mock).mock.calls[0][0];
    expect(log.request_id).toBe('my-trace-id');
  });

  it('generates a UUID when requestId is absent', () => {
    const req = makeReq();
    delete req.requestId;
    requestEntryLoggerMiddleware(req, makeRes(), jest.fn());
    const log = (logger.info as jest.Mock).mock.calls[0][0];
    expect(log.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('masks IP to /24 subnet (zeroes last octet)', () => {
    requestEntryLoggerMiddleware(makeReq({ ip: '203.0.113.42' }), makeRes(), jest.fn());
    const log = (logger.info as jest.Mock).mock.calls[0][0];
    expect(log.ip).toBe('203.0.113.0');
  });

  it('masks different /24 subnets correctly', () => {
    requestEntryLoggerMiddleware(makeReq({ ip: '192.168.1.99' }), makeRes(), jest.fn());
    const log = (logger.info as jest.Mock).mock.calls[0][0];
    expect(log.ip).toBe('192.168.1.0');
  });

  it('does not include request body', () => {
    requestEntryLoggerMiddleware(
      makeReq({ body: { password: 'secret' } }),
      makeRes(),
      jest.fn()
    );
    const log = (logger.info as jest.Mock).mock.calls[0][0];
    expect(log).not.toHaveProperty('body');
  });

  it('does not include query string', () => {
    requestEntryLoggerMiddleware(
      makeReq({ query: { secret_token: 'abc' } }),
      makeRes(),
      jest.fn()
    );
    const log = (logger.info as jest.Mock).mock.calls[0][0];
    expect(log).not.toHaveProperty('query');
  });

  it('logs the correct method', () => {
    requestEntryLoggerMiddleware(makeReq({ method: 'POST' }), makeRes(), jest.fn());
    const log = (logger.info as jest.Mock).mock.calls[0][0];
    expect(log.method).toBe('POST');
  });

  it('logs the correct path', () => {
    requestEntryLoggerMiddleware(makeReq({ path: '/api/v1/creators' }), makeRes(), jest.fn());
    const log = (logger.info as jest.Mock).mock.calls[0][0];
    expect(log.path).toBe('/api/v1/creators');
  });

  it('logs the user-agent header', () => {
    requestEntryLoggerMiddleware(
      makeReq({ headers: { 'user-agent': 'Mozilla/5.0' } }),
      makeRes(),
      jest.fn()
    );
    const log = (logger.info as jest.Mock).mock.calls[0][0];
    expect(log.user_agent).toBe('Mozilla/5.0');
  });
});
