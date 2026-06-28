// Integration test: GET /creators/:id/holders
//
// Exercises the full flow of the creator holders endpoint:
//   1. 404 when creator does not exist
//   2. Empty items list when creator exists but has no holders
//   3. Paginated holder list sorted by key_balance desc (default)
//   4. Holder list sorted by held_since asc (?sort=held_since)
//   5. Pagination meta (hasMore, total, limit, offset)
//
// Uses Jest mocks — no database required.

import { httpGetCreatorHolders } from './creator-holders.controller';
import * as holdersService from './creator-holders.service';
import type { HolderRecord } from './creator-holders.service';

// ── Lightweight request/response mocks ────────────────────────────────────────

function makeReq(
  params: Record<string, string> = {},
  query: Record<string, string> = {},
): any {
  return { params, query };
}

function makeRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  res.set = jest.fn().mockReturnValue(res);
  return res;
}

function makeNext(): jest.Mock {
  return jest.fn();
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CREATOR_STUB = { id: 'creator-cuid-1', handle: 'alice' };

function makeHolder(
  index: number,
  overrides: Partial<HolderRecord> = {},
): HolderRecord {
  return {
    wallet_address: `GWALLETADDRESS${String(index).padStart(46, '0')}`,
    key_balance: (4 - index) * 10, // 30, 20, 10 for indices 1, 2, 3
    held_since: new Date(`2024-0${index}-01T00:00:00.000Z`),
    ...overrides,
  };
}

const HOLDER_A = makeHolder(1); // balance: 30, earliest buyer
const HOLDER_B = makeHolder(2); // balance: 20
const HOLDER_C = makeHolder(3); // balance: 10, latest buyer

const ALL_HOLDERS = [HOLDER_A, HOLDER_B, HOLDER_C];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /creators/:id/holders', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Creator not found ──────────────────────────────────────────────────────

  it('returns 404 when the creator does not exist', async () => {
    jest
      .spyOn(holdersService, 'findCreatorByIdOrHandle')
      .mockResolvedValue(null);

    const req = makeReq({ id: 'nonexistent-creator' });
    const res = makeRes();
    await httpGetCreatorHolders(req, res, makeNext());

    expect(res.status).toHaveBeenCalledWith(404);

    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  // ── Creator exists but no holders ─────────────────────────────────────────

  it('returns empty items list (not 404) when creator exists but has no holders', async () => {
    jest
      .spyOn(holdersService, 'findCreatorByIdOrHandle')
      .mockResolvedValue(CREATOR_STUB);
    jest
      .spyOn(holdersService, 'fetchCreatorHolders')
      .mockResolvedValue([[], 0]);

    const req = makeReq({ id: CREATOR_STUB.handle });
    const res = makeRes();
    await httpGetCreatorHolders(req, res, makeNext());

    expect(res.status).toHaveBeenCalledWith(200);

    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.data.items).toEqual([]);
    expect(body.data.meta.total).toBe(0);
    expect(body.data.meta.hasMore).toBe(false);
  });

  // ── Default sort: key_balance desc ────────────────────────────────────────

  it('returns holders sorted by key_balance desc by default', async () => {
    jest
      .spyOn(holdersService, 'findCreatorByIdOrHandle')
      .mockResolvedValue(CREATOR_STUB);
    jest
      .spyOn(holdersService, 'fetchCreatorHolders')
      .mockResolvedValue([ALL_HOLDERS, ALL_HOLDERS.length]);

    const req = makeReq({ id: CREATOR_STUB.id });
    const res = makeRes();
    await httpGetCreatorHolders(req, res, makeNext());

    expect(res.status).toHaveBeenCalledWith(200);

    const body = res.json.mock.calls[0][0];
    const items = body.data.items as HolderRecord[];

    expect(items).toHaveLength(3);
    expect(items[0].wallet_address).toBe(HOLDER_A.wallet_address);
    expect(items[0].key_balance).toBe(HOLDER_A.key_balance); // 30
    expect(items[2].key_balance).toBe(HOLDER_C.key_balance); // 10

    // Verify fetchCreatorHolders was called with sort=key_balance
    const [, query] = (holdersService.fetchCreatorHolders as jest.Mock).mock.calls[0];
    expect(query.sort).toBe('key_balance');
  });

  // ── Sort by held_since ─────────────────────────────────────────────────────

  it('returns holders sorted by held_since asc when ?sort=held_since', async () => {
    jest
      .spyOn(holdersService, 'findCreatorByIdOrHandle')
      .mockResolvedValue(CREATOR_STUB);
    jest
      .spyOn(holdersService, 'fetchCreatorHolders')
      .mockResolvedValue([ALL_HOLDERS, ALL_HOLDERS.length]);

    const req = makeReq({ id: CREATOR_STUB.id }, { sort: 'held_since' });
    const res = makeRes();
    await httpGetCreatorHolders(req, res, makeNext());

    expect(res.status).toHaveBeenCalledWith(200);

    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);

    // Verify fetchCreatorHolders was called with sort=held_since
    const [, query] = (holdersService.fetchCreatorHolders as jest.Mock).mock.calls[0];
    expect(query.sort).toBe('held_since');
  });

  // ── Pagination ─────────────────────────────────────────────────────────────

  it('returns correct pagination meta for a partial page', async () => {
    const TOTAL = 10;
    const PAGE_ITEMS = ALL_HOLDERS; // 3 of 10

    jest
      .spyOn(holdersService, 'findCreatorByIdOrHandle')
      .mockResolvedValue(CREATOR_STUB);
    jest
      .spyOn(holdersService, 'fetchCreatorHolders')
      .mockResolvedValue([PAGE_ITEMS, TOTAL]);

    const req = makeReq({ id: CREATOR_STUB.id }, { limit: '3', offset: '0' });
    const res = makeRes();
    await httpGetCreatorHolders(req, res, makeNext());

    const body = res.json.mock.calls[0][0];
    const { meta } = body.data;

    expect(meta.limit).toBe(3);
    expect(meta.offset).toBe(0);
    expect(meta.total).toBe(TOTAL);
    expect(meta.hasMore).toBe(true);
  });

  it('returns hasMore=false on the last page', async () => {
    jest
      .spyOn(holdersService, 'findCreatorByIdOrHandle')
      .mockResolvedValue(CREATOR_STUB);
    jest
      .spyOn(holdersService, 'fetchCreatorHolders')
      .mockResolvedValue([ALL_HOLDERS, ALL_HOLDERS.length]);

    const req = makeReq({ id: CREATOR_STUB.id }, { limit: '20', offset: '0' });
    const res = makeRes();
    await httpGetCreatorHolders(req, res, makeNext());

    const { meta } = res.json.mock.calls[0][0].data;
    expect(meta.hasMore).toBe(false);
    expect(meta.total).toBe(3);
  });

  // ── Response shape ─────────────────────────────────────────────────────────

  it('each holder item has wallet_address, key_balance, and held_since', async () => {
    jest
      .spyOn(holdersService, 'findCreatorByIdOrHandle')
      .mockResolvedValue(CREATOR_STUB);
    jest
      .spyOn(holdersService, 'fetchCreatorHolders')
      .mockResolvedValue([[HOLDER_A], 1]);

    const req = makeReq({ id: CREATOR_STUB.id });
    const res = makeRes();
    await httpGetCreatorHolders(req, res, makeNext());

    const [item] = res.json.mock.calls[0][0].data.items as HolderRecord[];
    expect(item).toHaveProperty('wallet_address', HOLDER_A.wallet_address);
    expect(item).toHaveProperty('key_balance', HOLDER_A.key_balance);
    expect(item).toHaveProperty('held_since', HOLDER_A.held_since);
  });

  // ── Validation ─────────────────────────────────────────────────────────────

  it('returns 400 for an unknown query param (strict schema)', async () => {
    jest
      .spyOn(holdersService, 'findCreatorByIdOrHandle')
      .mockResolvedValue(CREATOR_STUB);

    const req = makeReq({ id: CREATOR_STUB.id }, { unknown_param: 'oops' });
    const res = makeRes();
    await httpGetCreatorHolders(req, res, makeNext());

    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(false);
  });

  it('returns 400 for an invalid sort value', async () => {
    jest
      .spyOn(holdersService, 'findCreatorByIdOrHandle')
      .mockResolvedValue(CREATOR_STUB);

    const req = makeReq({ id: CREATOR_STUB.id }, { sort: 'invalid_sort' });
    const res = makeRes();
    await httpGetCreatorHolders(req, res, makeNext());

    expect(res.status).toHaveBeenCalledWith(400);
  });

  // ── Error propagation ──────────────────────────────────────────────────────

  it('calls next(error) when the service throws', async () => {
    const dbError = new Error('DB connection failed');
    jest
      .spyOn(holdersService, 'findCreatorByIdOrHandle')
      .mockRejectedValue(dbError);

    const req = makeReq({ id: CREATOR_STUB.id });
    const res = makeRes();
    const next = makeNext();
    await httpGetCreatorHolders(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
    expect(res.json).not.toHaveBeenCalled();
  });
});
