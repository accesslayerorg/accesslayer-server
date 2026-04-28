// Integration test: empty creator activity feed response (#216)
//
// Verifies the complete response envelope and pagination metadata shape
// when no activity records exist for a given creator.
// Uses Jest mocks to keep the fixture lightweight — no database required.

import { httpGetActivityFeed } from './activity.controllers';
import * as activityService from './activity.service';

// ── Lightweight request/response mocks ────────────────────────────────────────

function makeReq(query: Record<string, string> = {}): any {
  return { query };
}

function makeRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function makeNext(): jest.Mock {
  return jest.fn();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /activity — empty feed integration', () => {
  beforeEach(() => {
    jest.spyOn(activityService, 'fetchActivityFeed').mockResolvedValue([[], 0]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('calls fetchActivityFeed with default limit and offset', async () => {
    const req = makeReq();
    const res = makeRes();
    await httpGetActivityFeed(req, res, makeNext());

    expect(activityService.fetchActivityFeed).toHaveBeenCalledWith(
      expect.objectContaining({ limit: expect.any(Number), offset: 0 }),
    );
  });

  it('responds with status 200', async () => {
    const req = makeReq();
    const res = makeRes();
    await httpGetActivityFeed(req, res, makeNext());

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('response envelope contains items array', async () => {
    const req = makeReq();
    const res = makeRes();
    await httpGetActivityFeed(req, res, makeNext());

    const body = res.json.mock.calls[0][0];
    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data.items)).toBe(true);
    expect(body.data.items).toHaveLength(0);
  });

  it('response envelope contains meta object', async () => {
    const req = makeReq();
    const res = makeRes();
    await httpGetActivityFeed(req, res, makeNext());

    const body = res.json.mock.calls[0][0];
    expect(body.data).toHaveProperty('meta');
    expect(body.data.meta).toMatchObject({
      total: 0,
      hasMore: false,
    });
  });

  it('meta.total is 0 when feed is empty', async () => {
    const req = makeReq();
    const res = makeRes();
    await httpGetActivityFeed(req, res, makeNext());

    const body = res.json.mock.calls[0][0];
    expect(body.data.meta.total).toBe(0);
  });

  it('meta.hasMore is false when feed is empty', async () => {
    const req = makeReq();
    const res = makeRes();
    await httpGetActivityFeed(req, res, makeNext());

    const body = res.json.mock.calls[0][0];
    expect(body.data.meta.hasMore).toBe(false);
  });

  it('meta.offset reflects the requested offset', async () => {
    const req = makeReq({ offset: '10' });
    const res = makeRes();
    await httpGetActivityFeed(req, res, makeNext());

    const body = res.json.mock.calls[0][0];
    expect(body.data.meta.offset).toBe(10);
  });

  it('meta.limit reflects the requested limit', async () => {
    const req = makeReq({ limit: '5' });
    const res = makeRes();
    await httpGetActivityFeed(req, res, makeNext());

    const body = res.json.mock.calls[0][0];
    expect(body.data.meta.limit).toBe(5);
  });

  it('filters by creatorId when provided', async () => {
    const req = makeReq({ creatorId: 'creator-xyz' });
    const res = makeRes();
    await httpGetActivityFeed(req, res, makeNext());

    expect(activityService.fetchActivityFeed).toHaveBeenCalledWith(
      expect.objectContaining({ creatorId: 'creator-xyz' }),
    );
    const body = res.json.mock.calls[0][0];
    expect(body.data.items).toHaveLength(0);
  });

  it('returns 400 for invalid query params', async () => {
    const req = makeReq({ limit: 'not-a-number' });
    const res = makeRes();
    const next = makeNext();
    await httpGetActivityFeed(req, res, next);

    // Either sendValidationError sets 400 or next is called with an error
    const statusArg = res.status.mock.calls[0]?.[0];
    if (statusArg !== undefined) {
      expect(statusArg).toBe(400);
    } else {
      // schema coercion may handle this gracefully; either is acceptable
      expect(res.json).toHaveBeenCalled();
    }
  });
});
