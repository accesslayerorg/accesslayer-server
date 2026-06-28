// Integration test: wallet holdings endpoint (#421)
//
// Covers: valid address returns holdings, invalid address returns 400,
// empty holdings, service error forwarded to next().
// Uses Jest mocks — no database required.

import { httpGetWalletHoldings } from '../wallet-holdings.controllers';
import * as walletHoldingsService from '../wallet-holdings.service';
import { HoldingEntry } from '../wallet-holdings.schemas';

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const MALFORMED_ADDRESS = 'not-a-stellar-address';

function makeReq(params: Record<string, string> = {}): any {
    return { params };
}

function makeRes(): any {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.setHeader = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
}

function makeNext(): jest.Mock {
    return jest.fn();
}

function makeHolding(overrides: Partial<HoldingEntry> = {}): HoldingEntry {
    return {
        creator_id: 'creator-1',
        creator_handle: 'alice',
        key_count: '5',
        current_price: '100',
        total_value: null,
        ...overrides,
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /wallets/:address/holdings', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('returns 200 with items and total for a wallet with holdings', async () => {
        const holdings: HoldingEntry[] = [
            makeHolding({ creator_id: 'creator-1', creator_handle: 'alice', key_count: '5' }),
            makeHolding({ creator_id: 'creator-2', creator_handle: 'bob', key_count: '3' }),
        ];
        jest.spyOn(walletHoldingsService, 'fetchWalletHoldings').mockResolvedValue([holdings, 2]);

        const req = makeReq({ address: VALID_ADDRESS });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        expect(res.status).toHaveBeenCalledWith(200);
        const body = res.json.mock.calls[0][0];
        expect(body.success).toBe(true);
        expect(body.data.items).toHaveLength(2);
        expect(body.data.total).toBe(2);
    });

    it('each holding includes required fields', async () => {
        const holding = makeHolding({
            creator_id: 'creator-1',
            creator_handle: 'alice',
            key_count: '10',
            current_price: '200',
            total_value: null,
        });
        jest.spyOn(walletHoldingsService, 'fetchWalletHoldings').mockResolvedValue([[holding], 1]);

        const req = makeReq({ address: VALID_ADDRESS });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        const item = res.json.mock.calls[0][0].data.items[0];
        expect(item).toMatchObject({
            creator_id: 'creator-1',
            creator_handle: 'alice',
            key_count: '10',
            current_price: '200',
        });
    });

    it('returns 200 with empty items for a wallet with no holdings', async () => {
        jest.spyOn(walletHoldingsService, 'fetchWalletHoldings').mockResolvedValue([[], 0]);

        const req = makeReq({ address: VALID_ADDRESS });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        expect(res.status).toHaveBeenCalledWith(200);
        const body = res.json.mock.calls[0][0];
        expect(body.data.items).toEqual([]);
        expect(body.data.total).toBe(0);
    });

    it('returns 400 for a malformed Stellar address', async () => {
        const req = makeReq({ address: MALFORMED_ADDRESS });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        expect(res.status).toHaveBeenCalledWith(400);
        const body = res.json.mock.calls[0][0];
        expect(body.success).toBe(false);
        expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for an address starting with wrong character', async () => {
        const req = makeReq({ address: 'A' + 'A'.repeat(55) });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('forwards service errors to next()', async () => {
        const err = new Error('db down');
        jest.spyOn(walletHoldingsService, 'fetchWalletHoldings').mockRejectedValue(err);

        const req = makeReq({ address: VALID_ADDRESS });
        const res = makeRes();
        const next = makeNext();
        await httpGetWalletHoldings(req, res, next);

        expect(next).toHaveBeenCalledWith(err);
    });
});
