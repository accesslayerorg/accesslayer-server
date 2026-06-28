// Integration test: wallet holdings endpoint (#511, #442)
//
// Covers: 400 for address that is too short, wrong prefix, invalid characters;
//         empty wallet → 200 + empty array, wallet with holdings → 200 + data.
// Uses Jest mocks — no database required.

import { httpGetWalletHoldings } from './wallet-holdings.controllers';
import * as walletHoldingsService from './wallet-holdings.service';
import { HoldingEntry } from './wallet-holdings.schemas';

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

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

function assertInvalidAddress(res: any, serviceSpy: jest.SpyInstance): void {
    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    const details: Array<{ field?: string; message: string }> = body.error.details ?? [];
    expect(details.some(d => d.field === 'address')).toBe(true);
    expect(serviceSpy).not.toHaveBeenCalled();
}

function makeHolding(overrides: Partial<HoldingEntry> = {}): HoldingEntry {
    return {
        creator_id: 'creator-1',
        creator_handle: null,
        key_count: '10',
        current_price: '0',
        total_value: null,
        ...overrides,
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /wallets/:address/holdings', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    // ── Malformed address: too short ──────────────────────────────────────────

    it('returns 400, identifies address field, and skips DB for an address that is too short', async () => {
        const serviceSpy = jest.spyOn(walletHoldingsService, 'fetchWalletHoldings');

        const req = makeReq({ address: 'GSHORT' });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        assertInvalidAddress(res, serviceSpy);
    });

    // ── Malformed address: wrong prefix ───────────────────────────────────────

    it('returns 400, identifies address field, and skips DB for an address with the wrong prefix', async () => {
        // Valid length and Base32 chars but starts with 'A' instead of 'G'
        const serviceSpy = jest.spyOn(walletHoldingsService, 'fetchWalletHoldings');

        const req = makeReq({ address: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        assertInvalidAddress(res, serviceSpy);
    });

    // ── Malformed address: invalid characters ─────────────────────────────────

    it('returns 400, identifies address field, and skips DB for an address with invalid characters', async () => {
        // Stellar Base32 allows only A-Z and 2-7; digit '0' is illegal
        const serviceSpy = jest.spyOn(walletHoldingsService, 'fetchWalletHoldings');

        const req = makeReq({ address: 'G000000000000000000000000000000000000000000000000000000' });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        assertInvalidAddress(res, serviceSpy);
    });

    // ── Valid address: service is called ──────────────────────────────────────

    it('calls the service and returns 200 for a valid Stellar address', async () => {
        jest.spyOn(walletHoldingsService, 'fetchWalletHoldings').mockResolvedValue([[], 0]);

        const req = makeReq({ address: VALID_ADDRESS });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        expect(res.status).toHaveBeenCalledWith(200);
        const body = res.json.mock.calls[0][0];
        expect(body.success).toBe(true);
        expect(body.data.items).toEqual([]);
        expect(body.data.total).toBe(0);
    });

    // ── Empty wallet ──────────────────────────────────────────────────────────

    it('returns 200 with empty items array for a wallet with no holdings', async () => {
        jest.spyOn(walletHoldingsService, 'fetchWalletHoldings').mockResolvedValue([[], 0]);

        const req = makeReq({ address: VALID_ADDRESS });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        expect(res.status).toHaveBeenCalledWith(200);
        const body = res.json.mock.calls[0][0];
        expect(body.success).toBe(true);
        expect(body.data.items).toEqual([]);
        expect(body.data.total).toBe(0);
    });

    // ── Wallet with holdings ──────────────────────────────────────────────────

    it('returns 200 with populated items for a wallet with positions', async () => {
        const items: HoldingEntry[] = [
            makeHolding({ creator_id: 'creator-1', key_count: '5', current_price: '100' }),
            makeHolding({ creator_id: 'creator-2', key_count: '3', current_price: '50' }),
        ];
        jest.spyOn(walletHoldingsService, 'fetchWalletHoldings').mockResolvedValue([items, 2]);

        const req = makeReq({ address: VALID_ADDRESS });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        expect(res.status).toHaveBeenCalledWith(200);
        const body = res.json.mock.calls[0][0];
        expect(body.success).toBe(true);
        expect(body.data.items).toHaveLength(2);
        expect(body.data.total).toBe(2);
    });

    it('each holding item includes required fields', async () => {
        const holding = makeHolding({
            creator_id: 'creator-xyz',
            creator_handle: 'creator-handle',
            key_count: '7',
            current_price: '100',
            total_value: '700',
        });
        jest.spyOn(walletHoldingsService, 'fetchWalletHoldings').mockResolvedValue([[holding], 1]);

        const req = makeReq({ address: VALID_ADDRESS });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        const item = res.json.mock.calls[0][0].data.items[0];
        expect(item).toMatchObject({
            creator_id: 'creator-xyz',
            creator_handle: 'creator-handle',
            key_count: '7',
            current_price: '100',
        });
    });

    it('passes the address to the service', async () => {
        const spy = jest
            .spyOn(walletHoldingsService, 'fetchWalletHoldings')
            .mockResolvedValue([[], 0]);

        const req = makeReq({ address: VALID_ADDRESS });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        expect(spy).toHaveBeenCalledWith(VALID_ADDRESS);
    });

    // ── Error forwarding ──────────────────────────────────────────────────────

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
