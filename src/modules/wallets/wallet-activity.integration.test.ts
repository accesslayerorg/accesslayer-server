// Integration test: wallet activity feed endpoint (#424)
//
// Covers: mixed history, type filter, creator_id filter, empty wallet,
// 400 on malformed address, pagination metadata.
// Uses Jest mocks — no database required.

import { httpGetWalletActivity } from './wallet-activity.controllers';
import * as walletActivityService from './wallet-activity.service';
import { WalletActivityItem } from './wallet-activity.schemas';

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const MALFORMED_ADDRESS = 'not-a-stellar-address';

function makeReq(params: Record<string, string> = {}, query: Record<string, string> = {}): any {
    return { params, query };
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

function makeActivity(overrides: Partial<WalletActivityItem> = {}): WalletActivityItem {
    return {
        type: 'buy',
        creator_id: 'creator-1',
        creator_handle: 'alice',
        amount: '10',
        price_at_trade: '50',
        fee_paid: '1',
        ledger_sequence: 100,
        timestamp: new Date('2026-01-01T00:00:00Z'),
        ...overrides,
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /wallets/:address/activity', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    // ── Happy path: mixed history ─────────────────────────────────────────────

    it('returns 200 with items and meta for a wallet with mixed trade history', async () => {
        const activities: WalletActivityItem[] = [
            makeActivity({ type: 'buy', creator_id: 'creator-1', creator_handle: 'alice' }),
            makeActivity({ type: 'sell', creator_id: 'creator-2', creator_handle: 'bob' }),
        ];
        jest.spyOn(walletActivityService, 'fetchWalletActivity').mockResolvedValue([activities, 2]);

        const req = makeReq({ address: VALID_ADDRESS });
        const res = makeRes();
        await httpGetWalletActivity(req, res, makeNext());

        expect(res.status).toHaveBeenCalledWith(200);
        const body = res.json.mock.calls[0][0];
        expect(body.success).toBe(true);
        expect(body.data.items).toHaveLength(2);
        expect(body.data.meta.total).toBe(2);
    });

    it('each item includes required trade fields', async () => {
        const activity = makeActivity({
            type: 'buy',
            creator_id: 'creator-1',
            creator_handle: 'alice',
            amount: '5',
            price_at_trade: '100',
            fee_paid: '2',
            ledger_sequence: 42,
            timestamp: new Date('2026-03-01T00:00:00Z'),
        });
        jest.spyOn(walletActivityService, 'fetchWalletActivity').mockResolvedValue([[activity], 1]);

        const req = makeReq({ address: VALID_ADDRESS });
        const res = makeRes();
        await httpGetWalletActivity(req, res, makeNext());

        const item = res.json.mock.calls[0][0].data.items[0];
        expect(item).toMatchObject({
            type: 'buy',
            creator_id: 'creator-1',
            creator_handle: 'alice',
            amount: '5',
            price_at_trade: '100',
            fee_paid: '2',
            ledger_sequence: 42,
        });
        expect(item.timestamp).toBeDefined();
    });

    // ── Empty wallet ──────────────────────────────────────────────────────────

    it('returns 200 with empty items array (not 404) for a wallet with no activity', async () => {
        jest.spyOn(walletActivityService, 'fetchWalletActivity').mockResolvedValue([[], 0]);

        const req = makeReq({ address: VALID_ADDRESS });
        const res = makeRes();
        await httpGetWalletActivity(req, res, makeNext());

        expect(res.status).toHaveBeenCalledWith(200);
        const body = res.json.mock.calls[0][0];
        expect(body.data.items).toEqual([]);
        expect(body.data.meta.total).toBe(0);
        expect(body.data.meta.hasMore).toBe(false);
    });

    // ── type filter ───────────────────────────────────────────────────────────

    it('passes type=buy filter to the service', async () => {
        const spy = jest.spyOn(walletActivityService, 'fetchWalletActivity').mockResolvedValue([[], 0]);

        const req = makeReq({ address: VALID_ADDRESS }, { type: 'buy' });
        const res = makeRes();
        await httpGetWalletActivity(req, res, makeNext());

        expect(spy).toHaveBeenCalledWith(
            VALID_ADDRESS,
            expect.objectContaining({ type: 'buy' })
        );
    });

    it('passes type=sell filter to the service', async () => {
        const spy = jest.spyOn(walletActivityService, 'fetchWalletActivity').mockResolvedValue([[], 0]);

        const req = makeReq({ address: VALID_ADDRESS }, { type: 'sell' });
        const res = makeRes();
        await httpGetWalletActivity(req, res, makeNext());

        expect(spy).toHaveBeenCalledWith(
            VALID_ADDRESS,
            expect.objectContaining({ type: 'sell' })
        );
    });

    it('returns only buy events when type=buy', async () => {
        const buys: WalletActivityItem[] = [makeActivity({ type: 'buy' })];
        jest.spyOn(walletActivityService, 'fetchWalletActivity').mockResolvedValue([buys, 1]);

        const req = makeReq({ address: VALID_ADDRESS }, { type: 'buy' });
        const res = makeRes();
        await httpGetWalletActivity(req, res, makeNext());

        const body = res.json.mock.calls[0][0];
        expect(body.data.items.every((i: WalletActivityItem) => i.type === 'buy')).toBe(true);
    });

    // ── creator_id filter ─────────────────────────────────────────────────────

    it('passes creator_id filter to the service', async () => {
        const spy = jest.spyOn(walletActivityService, 'fetchWalletActivity').mockResolvedValue([[], 0]);

        const req = makeReq({ address: VALID_ADDRESS }, { creator_id: 'creator-abc' });
        const res = makeRes();
        await httpGetWalletActivity(req, res, makeNext());

        expect(spy).toHaveBeenCalledWith(
            VALID_ADDRESS,
            expect.objectContaining({ creator_id: 'creator-abc' })
        );
    });

    it('returns only trades for the specified creator when creator_id is set', async () => {
        const items: WalletActivityItem[] = [
            makeActivity({ creator_id: 'creator-abc', creator_handle: 'target' }),
        ];
        jest.spyOn(walletActivityService, 'fetchWalletActivity').mockResolvedValue([items, 1]);

        const req = makeReq({ address: VALID_ADDRESS }, { creator_id: 'creator-abc' });
        const res = makeRes();
        await httpGetWalletActivity(req, res, makeNext());

        const body = res.json.mock.calls[0][0];
        expect(body.data.items.every((i: WalletActivityItem) => i.creator_id === 'creator-abc')).toBe(true);
    });

    // ── Malformed address → 400 ───────────────────────────────────────────────

    it('returns 400 for a malformed Stellar address', async () => {
        const req = makeReq({ address: MALFORMED_ADDRESS });
        const res = makeRes();
        await httpGetWalletActivity(req, res, makeNext());

        expect(res.status).toHaveBeenCalledWith(400);
        const body = res.json.mock.calls[0][0];
        expect(body.success).toBe(false);
        expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for an invalid type filter value', async () => {
        const req = makeReq({ address: VALID_ADDRESS }, { type: 'transfer' });
        const res = makeRes();
        await httpGetWalletActivity(req, res, makeNext());

        expect(res.status).toHaveBeenCalledWith(400);
    });

    // ── Pagination ────────────────────────────────────────────────────────────

    it('meta reflects limit and offset correctly', async () => {
        const items = Array.from({ length: 5 }, () => makeActivity());
        jest.spyOn(walletActivityService, 'fetchWalletActivity').mockResolvedValue([items, 50]);

        const req = makeReq({ address: VALID_ADDRESS }, { limit: '5', offset: '10' });
        const res = makeRes();
        await httpGetWalletActivity(req, res, makeNext());

        const meta = res.json.mock.calls[0][0].data.meta;
        expect(meta.limit).toBe(5);
        expect(meta.offset).toBe(10);
        expect(meta.total).toBe(50);
        expect(meta.hasMore).toBe(true);
    });

    it('hasMore is false when all items fit in one page', async () => {
        const items = [makeActivity()];
        jest.spyOn(walletActivityService, 'fetchWalletActivity').mockResolvedValue([items, 1]);

        const req = makeReq({ address: VALID_ADDRESS }, { limit: '20', offset: '0' });
        const res = makeRes();
        await httpGetWalletActivity(req, res, makeNext());

        expect(res.json.mock.calls[0][0].data.meta.hasMore).toBe(false);
    });

    it('forwards service errors to next()', async () => {
        const err = new Error('db down');
        jest.spyOn(walletActivityService, 'fetchWalletActivity').mockRejectedValue(err);

        const req = makeReq({ address: VALID_ADDRESS });
        const res = makeRes();
        const next = makeNext();
        await httpGetWalletActivity(req, res, next);

        expect(next).toHaveBeenCalledWith(err);
    });
});
