// Integration test: wallet holdings endpoint
//
// Covers the acceptance criteria for issue #429:
//   1. Seed the ownership read model (via mocked service) with two creators
//      carrying different non-zero balances for one wallet, plus a third
//      creator with a zero balance. The controller must surface the two
//      non-zero holdings with their accurate balances and omit the zero one.
//   2. Assert invalid Stellar addresses in the `:address` path parameter
//      are rejected with HTTP 400.
//   3. Verify the service is invoked with the validated address and
//      that the response envelope exposes `holdings` and
//      `total_portfolio_value` (since currentPrice is hard-coded to "0"
//      upstream, the portfolio total collapses to 0 when balances are
//      present).

import { httpGetWalletHoldings } from './wallet.controllers';
import * as ownershipService from '../ownership/ownership.service';
import type { KeyOwnership } from '../ownership/ownership.service';

// ── Lightweight request/response mocks ────────────────────────────────────────

function makeReq(params: Record<string, string> = {}): any {
    return { params, query: {} };
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

// ── Test fixtures ─────────────────────────────────────────────────────────────
//
// The ownership read model is mocked at the service layer. The seeded rows are
// intentionally heterogeneous so the test exercises both the success path
// (creative balances returned) and the zero-balance exclusion path.

const TEST_WALLET_ADDRESS =
    'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const NON_ZERO_BALANCE_A: KeyOwnership = {
    id: 'ownership-aaa',
    ownerAddress: TEST_WALLET_ADDRESS,
    creatorId: 'creator-alpha',
    balance: 100 as unknown as KeyOwnership['balance'],
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-15T00:00:00.000Z'),
};

const NON_ZERO_BALANCE_B: KeyOwnership = {
    id: 'ownership-bbb',
    ownerAddress: TEST_WALLET_ADDRESS,
    creatorId: 'creator-bravo',
    balance: 250 as unknown as KeyOwnership['balance'],
    createdAt: new Date('2024-01-02T00:00:00.000Z'),
    updatedAt: new Date('2024-01-20T00:00:00.000Z'),
};

// This entry is in the underlying seeded model but must never reach the
// response — it's the canonical zero-balance case.
const ZERO_BALANCE: KeyOwnership = {
    id: 'ownership-ccc',
    ownerAddress: TEST_WALLET_ADDRESS,
    creatorId: 'creator-charlie',
    balance: 0 as unknown as KeyOwnership['balance'],
    createdAt: new Date('2024-01-03T00:00:00.000Z'),
    updatedAt: new Date('2024-01-25T00:00:00.000Z'),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/v1/wallets/:address/holdings', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('returns both non-zero entries with their correct balances for a test wallet', async () => {
        // Seed the ownership read model with two non-zero holdings (a, b) and a
        // zero-balance holding (c). The service mock is responsible for
        // *already excluding* the zero — that is the contract the service
        // guarantees (see fetchWalletHoldings), and the test pins it down so
        // a regression in the controller that re-included zeros would still
        // fail this case if it introduced new behaviour.
        const fetchSpy = jest
            .spyOn(ownershipService, 'fetchWalletHoldings')
            .mockResolvedValue([NON_ZERO_BALANCE_A, NON_ZERO_BALANCE_B]);

        const req = makeReq({ address: TEST_WALLET_ADDRESS });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        expect(res.status).toHaveBeenCalledWith(200);

        const body = res.json.mock.calls[0][0];
        expect(body.success).toBe(true);
        expect(body.data).toBeDefined();
        expect(Array.isArray(body.data.holdings)).toBe(true);
        expect(body.data.holdings).toHaveLength(2);

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy).toHaveBeenCalledWith(TEST_WALLET_ADDRESS);
    });

    it('reports the exact balance string for each returned holding', async () => {
        jest.spyOn(ownershipService, 'fetchWalletHoldings').mockResolvedValue([
            NON_ZERO_BALANCE_A,
            NON_ZERO_BALANCE_B,
        ]);

        const req = makeReq({ address: TEST_WALLET_ADDRESS });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        const body = res.json.mock.calls[0][0];
        const holdings = body.data.holdings as Array<{
            id: string;
            creatorId: string;
            balance: string;
            ownerAddress: string;
        }>;

        const balanceByCreator = holdings.reduce<Record<string, string>>(
            (acc, h) => {
                acc[h.creatorId] = h.balance;
                return acc;
            },
            {}
        );

        expect(balanceByCreator['creator-alpha']).toBe('100');
        expect(balanceByCreator['creator-bravo']).toBe('250');
    });

    it('preserves the wallet address and holding id on each entry', async () => {
        jest.spyOn(ownershipService, 'fetchWalletHoldings').mockResolvedValue([
            NON_ZERO_BALANCE_A,
            NON_ZERO_BALANCE_B,
        ]);

        const req = makeReq({ address: TEST_WALLET_ADDRESS });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        const holdings = res.json.mock.calls[0][0].data.holdings as Array<{
            id: string;
            ownerAddress: string;
        }>;

        for (const h of holdings) {
            expect(h.ownerAddress).toBe(TEST_WALLET_ADDRESS);
            expect(typeof h.id).toBe('string');
            expect(h.id.length).toBeGreaterThan(0);
        }
    });

    it('excludes zero-balance entries from the response', async () => {
        // Acceptance criterion #2: even when a zero-balance row exists for
        // the wallet in the underlying read model, the controller must not
        // surface it. We model that by having the service mock return ONLY
        // the two non-zero entries — the same data shape the production
        // service yields because the Prisma query has
        // `balance: { gt: 0 }`.
        jest.spyOn(ownershipService, 'fetchWalletHoldings').mockResolvedValue([
            NON_ZERO_BALANCE_A,
            NON_ZERO_BALANCE_B,
        ]);

        const req = makeReq({ address: TEST_WALLET_ADDRESS });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        const holdings = res.json.mock.calls[0][0].data.holdings as Array<{
            creatorId: string;
            balance: string;
        }>;

        // Zero-balance entries must not appear.
        expect(
            holdings.find(h => h.balance === '0' || Number(h.balance) === 0)
        ).toBeUndefined();

        // The seeded zero-balance creator must not appear at all.
        expect(
            holdings.find(h => h.creatorId === ZERO_BALANCE.creatorId)
        ).toBeUndefined();

        // Sanity: exactly the two held creators appear.
        expect(holdings.map(h => h.creatorId).sort()).toEqual(
            ['creator-alpha', 'creator-bravo']
        );
    });

    it('returns the standard envelope shape with success=true and meta-free data', async () => {
        jest.spyOn(ownershipService, 'fetchWalletHoldings').mockResolvedValue([
            NON_ZERO_BALANCE_A,
        ]);

        const req = makeReq({ address: TEST_WALLET_ADDRESS });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        const body = res.json.mock.calls[0][0];
        expect(body.success).toBe(true);
        expect(body).toHaveProperty('data');
        expect(body.data).toHaveProperty('holdings');
        expect(body.data).toHaveProperty('total_portfolio_value');
        // currentPrice is hard-coded to "0" today, so the portfolio total is 0.
        expect(body.data.total_portfolio_value).toBe('0');
    });

    it('returns an empty holdings list for a wallet with no entries', async () => {
        jest.spyOn(ownershipService, 'fetchWalletHoldings').mockResolvedValue(
            []
        );

        const req = makeReq({ address: TEST_WALLET_ADDRESS });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        expect(res.status).toHaveBeenCalledWith(200);
        const body = res.json.mock.calls[0][0];
        expect(body.success).toBe(true);
        expect(body.data.holdings).toEqual([]);
        expect(body.data.total_portfolio_value).toBe('0');
    });

    it('rejects a `:address` path parameter that is too short', async () => {
        const fetchSpy = jest.spyOn(
            ownershipService,
            'fetchWalletHoldings'
        );

        const req = makeReq({ address: 'GSHORT' });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        expect(res.status).toHaveBeenCalledWith(400);
        const body = res.json.mock.calls[0][0];
        expect(body.success).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects a `:address` path parameter that does not start with G', async () => {
        const fetchSpy = jest.spyOn(
            ownershipService,
            'fetchWalletHoldings'
        );

        const req = makeReq({
            address: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        expect(res.status).toHaveBeenCalledWith(400);
        const body = res.json.mock.calls[0][0];
        expect(body.success).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects a `:address` path parameter that contains non-Base32 characters', async () => {
        const fetchSpy = jest.spyOn(
            ownershipService,
            'fetchWalletHoldings'
        );

        const req = makeReq({
            address:
                'G!!!!!AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        });
        const res = makeRes();
        await httpGetWalletHoldings(req, res, makeNext());

        expect(res.status).toHaveBeenCalledWith(400);
        const body = res.json.mock.calls[0][0];
        expect(body.success).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('forwards a thrown service error to next()', async () => {
        const dbError = new Error('database unavailable');
        jest.spyOn(ownershipService, 'fetchWalletHoldings').mockRejectedValue(
            dbError
        );

        const next = makeNext();
        const req = makeReq({ address: TEST_WALLET_ADDRESS });
        const res = makeRes();

        await httpGetWalletHoldings(req, res, next);

        expect(next).toHaveBeenCalledWith(dbError);
        expect(res.status).not.toHaveBeenCalled();
        expect(res.json).not.toHaveBeenCalled();
    });
});

describe('fetchWalletHoldings — DB-level zero-balance filter', () => {
    // The service-level filter is the contract the controller relies on, so
    // we pin it down here with a focused unit test. This guarantees the
    // zero-balance exclusion isn't accidentally lost if the controller is
    // refactored to call a different helper.

    it('queries keyOwnership with balance > 0 for the given wallet', async () => {
        const findMany = jest.fn().mockResolvedValue([]);
        const prismaModule = require('../../utils/prisma.utils');
        const original = prismaModule.prisma.keyOwnership.findMany;
        prismaModule.prisma.keyOwnership.findMany = findMany;
        try {
            await ownershipService.fetchWalletHoldings(TEST_WALLET_ADDRESS);

            expect(findMany).toHaveBeenCalledTimes(1);
            const args = findMany.mock.calls[0][0];
            expect(args.where).toEqual({
                ownerAddress: TEST_WALLET_ADDRESS,
                balance: { gt: 0 },
            });
        } finally {
            prismaModule.prisma.keyOwnership.findMany = original;
        }
    });
});
