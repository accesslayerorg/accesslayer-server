// Integration test: wallet holdings endpoint (#511)
//
// Covers: 400 for address that is too short, wrong prefix, invalid characters.
// Asserts the `address` field is identified in the error body and no database
// query is attempted for any invalid input.
// Uses Jest mocks — no database required.

import { httpGetWalletHoldings } from './wallet-holdings.controllers';
import * as walletHoldingsService from './wallet-holdings.service';

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
});
