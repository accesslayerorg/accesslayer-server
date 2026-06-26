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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /wallets/:address/holdings', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    // ── Malformed address: too short ──────────────────────────────────────────

    it('returns 400 for an address that is too short', async () => {
        const serviceSpy = jest.spyOn(walletHoldingsService, 'fetchWalletHoldings');

        const req = makeReq({ address: 'GSHORT' });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('identifies the address field in the error body when address is too short', async () => {
        const req = makeReq({ address: 'GSHORT' });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        const body = res.json.mock.calls[0][0];
        expect(body.success).toBe(false);
        expect(body.error.code).toBe('VALIDATION_ERROR');
        const details: Array<{ field?: string; message: string }> = body.error.details ?? [];
        expect(details.some(d => d.field === 'address')).toBe(true);
    });

    it('does not query the database when address is too short', async () => {
        const serviceSpy = jest.spyOn(walletHoldingsService, 'fetchWalletHoldings');

        const req = makeReq({ address: 'GSHORT' });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        expect(serviceSpy).not.toHaveBeenCalled();
    });

    // ── Malformed address: wrong prefix ───────────────────────────────────────

    it('returns 400 for an address with the wrong prefix', async () => {
        // Valid length and Base32 chars but starts with 'A' instead of 'G'
        const wrongPrefix = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
        const serviceSpy = jest.spyOn(walletHoldingsService, 'fetchWalletHoldings');

        const req = makeReq({ address: wrongPrefix });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('identifies the address field in the error body for a wrong-prefix address', async () => {
        const wrongPrefix = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

        const req = makeReq({ address: wrongPrefix });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        const body = res.json.mock.calls[0][0];
        expect(body.success).toBe(false);
        expect(body.error.code).toBe('VALIDATION_ERROR');
        const details: Array<{ field?: string; message: string }> = body.error.details ?? [];
        expect(details.some(d => d.field === 'address')).toBe(true);
    });

    it('does not query the database when address has the wrong prefix', async () => {
        const wrongPrefix = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
        const serviceSpy = jest.spyOn(walletHoldingsService, 'fetchWalletHoldings');

        const req = makeReq({ address: wrongPrefix });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        expect(serviceSpy).not.toHaveBeenCalled();
    });

    // ── Malformed address: invalid characters ─────────────────────────────────

    it('returns 400 for an address containing invalid characters', async () => {
        // Stellar Base32 allows only A-Z and 2-7; digits 0, 1, 8, 9 and
        // lowercase letters are all illegal
        const invalidChars = 'G000000000000000000000000000000000000000000000000000000';
        const serviceSpy = jest.spyOn(walletHoldingsService, 'fetchWalletHoldings');

        const req = makeReq({ address: invalidChars });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('identifies the address field in the error body for an address with invalid characters', async () => {
        const invalidChars = 'G000000000000000000000000000000000000000000000000000000';

        const req = makeReq({ address: invalidChars });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        const body = res.json.mock.calls[0][0];
        expect(body.success).toBe(false);
        expect(body.error.code).toBe('VALIDATION_ERROR');
        const details: Array<{ field?: string; message: string }> = body.error.details ?? [];
        expect(details.some(d => d.field === 'address')).toBe(true);
    });

    it('does not query the database when address contains invalid characters', async () => {
        const invalidChars = 'G000000000000000000000000000000000000000000000000000000';
        const serviceSpy = jest.spyOn(walletHoldingsService, 'fetchWalletHoldings');

        const req = makeReq({ address: invalidChars });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        expect(serviceSpy).not.toHaveBeenCalled();
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
