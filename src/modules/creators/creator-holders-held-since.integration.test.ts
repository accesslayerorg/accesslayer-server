// Integration test: held_since reflects first-buy timestamp for each holder (#493)
//
// Uses Jest mocks (no live DB required). Exercises the full controller → service
// chain for GET /creators/:id/holders, confirming that:
//   1. Each holder's held_since matches the createdAt of their first-buy ownership row
//   2. A wallet that bought twice still shows the earliest buy timestamp
//   3. held_since is returned in ISO 8601 format
//   4. Multiple holders who bought at different times each show their own timestamp

import { httpGetCreatorHolders } from './creator-holders.controller';
import * as holdersService from './creator-holders.service';
import type { HolderRecord } from './creator-holders.service';

function makeReq(params: Record<string, string> = {}, query: Record<string, string> = {}): any {
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
function makeNext() { return jest.fn(); }

const CREATOR = { id: 'creator-abc', handle: 'alice' };

// Three wallets with distinct first-buy timestamps
const TS_WALLET_A = new Date('2024-01-15T08:00:00.000Z');
const TS_WALLET_B = new Date('2024-02-20T12:30:00.000Z');
const TS_WALLET_C = new Date('2024-03-10T16:45:00.000Z');

const HOLDER_A: HolderRecord = {
  wallet_address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1',
  key_balance: 30,
  held_since: TS_WALLET_A,
};
const HOLDER_B: HolderRecord = {
  wallet_address: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2',
  key_balance: 20,
  held_since: TS_WALLET_B,
};
// Wallet C bought twice — held_since is still its FIRST buy (TS_WALLET_C)
const HOLDER_C: HolderRecord = {
  wallet_address: 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC3',
  key_balance: 15, // bought 10 then 5 more
  held_since: TS_WALLET_C, // createdAt from first buy — never updated on re-buy
};

describe('GET /creators/:id/holders — held_since per wallet (#493)', () => {
  beforeEach(() => {
    jest.spyOn(holdersService, 'findCreatorByIdOrHandle').mockResolvedValue(CREATOR);
    jest.restoreAllMocks();
    jest.spyOn(holdersService, 'findCreatorByIdOrHandle').mockResolvedValue(CREATOR);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('each holder's held_since matches their first-buy timestamp', async () => {
    jest
      .spyOn(holdersService, 'fetchCreatorHolders')
      .mockResolvedValue([[HOLDER_A, HOLDER_B, HOLDER_C], 3]);

    const req = makeReq({ id: CREATOR.id });
    const res = makeRes();
    await httpGetCreatorHolders(req, res, makeNext());

    expect(res.status).toHaveBeenCalledWith(200);
    const items: HolderRecord[] = res.json.mock.calls[0][0].data.items;
    expect(items).toHaveLength(3);

    expect(items[0].held_since).toEqual(TS_WALLET_A);
    expect(items[1].held_since).toEqual(TS_WALLET_B);
    expect(items[2].held_since).toEqual(TS_WALLET_C);
  });

  it('wallet that bought twice shows the earliest buy timestamp (not most recent)', async () => {
    // Even though wallet C bought twice, held_since = TS_WALLET_C (first buy)
    // The second buy only changes balance, not createdAt in KeyOwnership
    jest
      .spyOn(holdersService, 'fetchCreatorHolders')
      .mockResolvedValue([[HOLDER_C], 1]);

    const req = makeReq({ id: CREATOR.id });
    const res = makeRes();
    await httpGetCreatorHolders(req, res, makeNext());

    const [item] = res.json.mock.calls[0][0].data.items as HolderRecord[];
    expect(item.held_since).toEqual(TS_WALLET_C);
    expect(item.key_balance).toBe(15); // reflects total of both buys
    // Confirm held_since is the first-buy timestamp, not the second-buy time
    expect(item.held_since.getTime()).toBe(TS_WALLET_C.getTime());
    expect(item.held_since.getTime()).toBeLessThan(Date.now());
  });

  it('held_since values are in ISO 8601 format when serialised to JSON', async () => {
    jest
      .spyOn(holdersService, 'fetchCreatorHolders')
      .mockResolvedValue([[HOLDER_A, HOLDER_B], 2]);

    const req = makeReq({ id: CREATOR.id });
    const res = makeRes();
    await httpGetCreatorHolders(req, res, makeNext());

    const items: HolderRecord[] = res.json.mock.calls[0][0].data.items;
    for (const item of items) {
      const iso = (item.held_since instanceof Date
        ? item.held_since.toISOString()
        : String(item.held_since));
      expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it('three wallets with different first-buy timestamps each show their own held_since', async () => {
    jest
      .spyOn(holdersService, 'fetchCreatorHolders')
      .mockResolvedValue([[HOLDER_A, HOLDER_B, HOLDER_C], 3]);

    const req = makeReq({ id: CREATOR.id }, { sort: 'held_since' });
    const res = makeRes();
    await httpGetCreatorHolders(req, res, makeNext());

    const items: HolderRecord[] = res.json.mock.calls[0][0].data.items;
    const heldSinceTimes = items.map((i) =>
      i.held_since instanceof Date ? i.held_since.getTime() : 0,
    );
    // All timestamps are distinct — no two wallets share a held_since
    const unique = new Set(heldSinceTimes);
    expect(unique.size).toBe(3);
  });

  it('fetchCreatorHolders is called with sort=key_balance when no sort param', async () => {
    jest
      .spyOn(holdersService, 'fetchCreatorHolders')
      .mockResolvedValue([[HOLDER_A], 1]);

    const req = makeReq({ id: CREATOR.id });
    await httpGetCreatorHolders(req, makeRes(), makeNext());

    const [, query] = (holdersService.fetchCreatorHolders as jest.Mock).mock.calls[0];
    expect(query.sort).toBe('key_balance');
  });

  it('fetchCreatorHolders is called with sort=held_since when requested', async () => {
    jest
      .spyOn(holdersService, 'fetchCreatorHolders')
      .mockResolvedValue([[HOLDER_A, HOLDER_B, HOLDER_C], 3]);

    const req = makeReq({ id: CREATOR.id }, { sort: 'held_since' });
    await httpGetCreatorHolders(req, makeRes(), makeNext());

    const [, query] = (holdersService.fetchCreatorHolders as jest.Mock).mock.calls[0];
    expect(query.sort).toBe('held_since');
  });
});
