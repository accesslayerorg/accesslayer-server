import { httpGetWalletActivity } from '../wallet-activity.controllers';
import * as walletActivityService from '../wallet-activity.service';
import { encodeCursor, decodeCursor } from '../../../utils/cursor.utils';
import type { ActivityFeedCursorPayload } from '../wallet-activity.service';

function makeReq(params: Record<string, string> = {}, query: Record<string, string> = {}): any {
    return { params, query };
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

const WALLET_ADDRESS = 'GBRST3QZ5XQQ74345MTHXMY3R745B6N5J2S7K6D6NCT7YIHMHQ45X2WZ';

function makeFixture(index: number) {
    return {
        id: `activity-${index}`,
        type: 'buy' as const,
        creator_id: `creator-${index}`,
        creator_handle: `handle-${index}`,
        amount: index * 100,
        price_at_trade: index * 10,
        fee_paid: index,
        ledger_sequence: 1000 + index,
        timestamp: new Date(`2024-0${index}-01T00:00:00.000Z`),
    };
}

const ALL_FIXTURES = [6, 5, 4, 3, 2, 1].map(makeFixture);
const PAGE_ONE_FIXTURES = ALL_FIXTURES.slice(0, 3);
const PAGE_TWO_FIXTURES = ALL_FIXTURES.slice(3, 6);

describe('wallet activity feed cursor-based pagination integration', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('returns a valid next cursor on the first page', async () => {
        const lastOnPageOne = PAGE_ONE_FIXTURES[PAGE_ONE_FIXTURES.length - 1];
        const nextCursorStr = encodeCursor<ActivityFeedCursorPayload>({ id: lastOnPageOne.id });

        jest.spyOn(walletActivityService, 'fetchWalletActivity').mockResolvedValue([
            PAGE_ONE_FIXTURES,
            ALL_FIXTURES.length,
            nextCursorStr
        ]);

        const req = makeReq({ address: WALLET_ADDRESS }, { limit: '3', offset: '0' });
        const res = makeRes();
        await httpGetWalletActivity(req, res, makeNext());

        expect(res.status).toHaveBeenCalledWith(200);

        const body = res.json.mock.calls[0][0];
        expect(body.data.items).toHaveLength(3);
        expect(body.data.meta.nextCursor).toBe(nextCursorStr);
        expect(body.data.meta.hasMore).toBe(true);
    });

    it('fetches the second page using the cursor and confirms no duplicates', async () => {
        const lastOnPageOne = PAGE_ONE_FIXTURES[PAGE_ONE_FIXTURES.length - 1];
        const nextCursorStr = encodeCursor<ActivityFeedCursorPayload>({ id: lastOnPageOne.id });

        jest.spyOn(walletActivityService, 'fetchWalletActivity').mockResolvedValue([
            PAGE_ONE_FIXTURES,
            ALL_FIXTURES.length,
            nextCursorStr
        ]);

        const reqOne = makeReq({ address: WALLET_ADDRESS }, { limit: '3', offset: '0' });
        const resOne = makeRes();
        await httpGetWalletActivity(reqOne, resOne, makeNext());
        const pageOneIds = resOne.json.mock.calls[0][0].data.items.map((i: any) => i.id);

        jest.restoreAllMocks();

        jest.spyOn(walletActivityService, 'fetchWalletActivity').mockResolvedValue([
            PAGE_TWO_FIXTURES,
            ALL_FIXTURES.length,
            null
        ]);

        const reqTwo = makeReq({ address: WALLET_ADDRESS }, { limit: '3', cursor: nextCursorStr });
        const resTwo = makeRes();
        await httpGetWalletActivity(reqTwo, resTwo, makeNext());

        const bodyTwo = resTwo.json.mock.calls[0][0];
        const pageTwoIds = bodyTwo.data.items.map((i: any) => i.id);

        expect(bodyTwo.data.items).toHaveLength(3);
        expect(bodyTwo.data.meta.nextCursor).toBeNull();
        expect(bodyTwo.data.meta.hasMore).toBe(false);

        const overlap = pageOneIds.filter((id: string) => pageTwoIds.includes(id));
        expect(overlap).toHaveLength(0);

        const allExpectedIds = ALL_FIXTURES.map(f => f.id);
        const combinedIds = [...pageOneIds, ...pageTwoIds];
        expect(combinedIds).toEqual(allExpectedIds);
    });
});
