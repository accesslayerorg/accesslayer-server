// Integration test: alert registration returns 400 for invalid Stellar wallet address (#491)
//
// Covers: POST /alerts with a malformed wallet_address is rejected with 400
// before any database write occurs.
// Uses Jest mocks — no database required.

import { httpCreateAlert } from '../alert.controllers';
import * as alertService from '../alert.service';

jest.mock('../../../utils/prisma.utils', () => ({
    prisma: {
        priceAlert: {
            create: jest.fn(),
        },
    },
}));

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

function makeReq(body: Record<string, unknown>): any {
    return { body };
}

const VALID_PAYLOAD = {
    creator_id: 'creator-1',
    wallet_address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    target_price: 100,
    direction: 'above',
    callback_url: 'https://example.com/cb',
};

describe('POST /alerts — invalid Stellar wallet address', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('returns 400 for a malformed wallet address', async () => {
        const req = makeReq({ ...VALID_PAYLOAD, wallet_address: 'not-a-stellar-address' });
        const res = makeRes();

        await httpCreateAlert(req, res, makeNext());

        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('error body identifies the wallet_address field', async () => {
        const req = makeReq({ ...VALID_PAYLOAD, wallet_address: 'BADINPUT' });
        const res = makeRes();

        await httpCreateAlert(req, res, makeNext());

        const body = res.json.mock.calls[0][0];
        expect(body.success).toBe(false);
        const details: Array<{ field: string; message: string }> = body.error.details ?? [];
        const fieldNames = details.map((d) => d.field);
        expect(fieldNames).toContain('wallet_address');
    });

    it('does not create an alert record after failed validation', async () => {
        const createSpy = jest.spyOn(alertService, 'createAlert');
        const req = makeReq({ ...VALID_PAYLOAD, wallet_address: 'invalid' });
        const res = makeRes();

        await httpCreateAlert(req, res, makeNext());

        expect(createSpy).not.toHaveBeenCalled();
    });
});
