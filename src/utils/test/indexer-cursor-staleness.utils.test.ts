import { warnIfIndexerCursorStale } from '../indexer-cursor-staleness.utils';
import { logger } from '../logger.utils';

jest.mock('../logger.utils', () => ({
  logger: { warn: jest.fn() },
}));

const warnMock = logger.warn as jest.Mock;

beforeEach(() => {
  warnMock.mockClear();
});

describe('warnIfIndexerCursorStale()', () => {
  it('emits a warning when cursor age exceeds the threshold', () => {
    const sixMinutesAgo = new Date(Date.now() - 360_000);
    warnIfIndexerCursorStale(sixMinutesAgo, 300_000);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: 'Indexer cursor is stale',
        thresholdMs: 300_000,
      })
    );
  });

  it('does not emit a warning when cursor age is within the threshold', () => {
    const oneMinuteAgo = new Date(Date.now() - 60_000);
    warnIfIndexerCursorStale(oneMinuteAgo, 300_000);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('does not emit a warning when cursor age exactly equals the threshold', () => {
    const exactly = new Date(Date.now() - 300_000);
    warnIfIndexerCursorStale(exactly, 300_000);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('includes lastUpdatedAt, ageMs and thresholdMs in the warning payload', () => {
    const ts = new Date(Date.now() - 400_000);
    warnIfIndexerCursorStale(ts, 300_000);
    const call = warnMock.mock.calls[0][0];
    expect(call.lastUpdatedAt).toBe(ts.toISOString());
    expect(typeof call.ageMs).toBe('number');
    expect(call.ageMs).toBeGreaterThan(300_000);
    expect(call.thresholdMs).toBe(300_000);
  });

  it('respects a custom threshold override', () => {
    const twoSecondsAgo = new Date(Date.now() - 2_000);
    warnIfIndexerCursorStale(twoSecondsAgo, 1_000);
    expect(warnMock).toHaveBeenCalledTimes(1);
  });
});
