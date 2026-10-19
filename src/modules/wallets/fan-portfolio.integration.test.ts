// Integration test: fan portfolio endpoint aggregating holdings across multiple creators (#601)
//
// Scope:
//   - Seeds a wallet with holdings in three different creators at different quantities
//   - Calls the fan portfolio endpoint for that wallet
//   - Asserts all three creators appear in the response with correct quantity and total_value
//   - Asserts a creator not held by the wallet is absent from the response
//   - Asserts the response includes a grand_total field summing all total_value entries
//
// Uses Jest mocks — no database required.

import { httpGetWalletHoldings } from './wallet-holdings.controllers';
import * as walletHoldingsService from './wallet-holdings.service';
import { HoldingEntry } from './wallet-holdings.schemas';

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_ADDRESS =
   'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function makeReq(
   params: Record<string, string> = {},
   query: Record<string, string> = {}
): any {
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

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Wallet holds keys across three creators
const HOLDING_CREATOR_A: HoldingEntry = {
   creator_id: 'creator-alpha',
   creator_handle: 'alpha',
   key_count: '10',
   current_price: '500',
   total_value: '5000', // 10 * 500
};

const HOLDING_CREATOR_B: HoldingEntry = {
   creator_id: 'creator-beta',
   creator_handle: 'beta',
   key_count: '5',
   current_price: '200',
   total_value: '1000', // 5 * 200
};

const HOLDING_CREATOR_C: HoldingEntry = {
   creator_id: 'creator-gamma',
   creator_handle: 'gamma',
   key_count: '3',
   current_price: '100',
   total_value: '300', // 3 * 100
};

// grand_total = 5000 + 1000 + 300 = 6300
const EXPECTED_GRAND_TOTAL = '6300';

const HELD_CREATOR_ID_NOT_IN_RESPONSE = 'creator-not-held';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('#601 fan portfolio endpoint — aggregated holdings', () => {
   afterEach(() => {
      jest.restoreAllMocks();
   });

   // ── All three creators appear in response ─────────────────────────────────

   it('returns 200 with all three held creators in the response', async () => {
      jest
         .spyOn(walletHoldingsService, 'fetchWalletHoldings')
         .mockResolvedValue([
            [HOLDING_CREATOR_A, HOLDING_CREATOR_B, HOLDING_CREATOR_C],
            3,
         ]);

      const req = makeReq({ address: VALID_ADDRESS });
      const res = makeRes();
      await httpGetWalletHoldings(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(true);
      expect(body.data.items).toHaveLength(3);
   });

   it('creator-alpha is present in the response', async () => {
      jest
         .spyOn(walletHoldingsService, 'fetchWalletHoldings')
         .mockResolvedValue([
            [HOLDING_CREATOR_A, HOLDING_CREATOR_B, HOLDING_CREATOR_C],
            3,
         ]);

      const req = makeReq({ address: VALID_ADDRESS });
      const res = makeRes();
      await httpGetWalletHoldings(req, res, makeNext());

      const items: HoldingEntry[] = res.json.mock.calls[0][0].data.items;
      const alpha = items.find(i => i.creator_id === 'creator-alpha');
      expect(alpha).toBeDefined();
   });

   it('creator-beta is present in the response', async () => {
      jest
         .spyOn(walletHoldingsService, 'fetchWalletHoldings')
         .mockResolvedValue([
            [HOLDING_CREATOR_A, HOLDING_CREATOR_B, HOLDING_CREATOR_C],
            3,
         ]);

      const req = makeReq({ address: VALID_ADDRESS });
      const res = makeRes();
      await httpGetWalletHoldings(req, res, makeNext());

      const items: HoldingEntry[] = res.json.mock.calls[0][0].data.items;
      const beta = items.find(i => i.creator_id === 'creator-beta');
      expect(beta).toBeDefined();
   });

   it('creator-gamma is present in the response', async () => {
      jest
         .spyOn(walletHoldingsService, 'fetchWalletHoldings')
         .mockResolvedValue([
            [HOLDING_CREATOR_A, HOLDING_CREATOR_B, HOLDING_CREATOR_C],
            3,
         ]);

      const req = makeReq({ address: VALID_ADDRESS });
      const res = makeRes();
      await httpGetWalletHoldings(req, res, makeNext());

      const items: HoldingEntry[] = res.json.mock.calls[0][0].data.items;
      const gamma = items.find(i => i.creator_id === 'creator-gamma');
      expect(gamma).toBeDefined();
   });

   // ── quantity and total_value correct for each creator ─────────────────────

   it('creator-alpha has correct key_count and total_value', async () => {
      jest
         .spyOn(walletHoldingsService, 'fetchWalletHoldings')
         .mockResolvedValue([
            [HOLDING_CREATOR_A, HOLDING_CREATOR_B, HOLDING_CREATOR_C],
            3,
         ]);

      const req = makeReq({ address: VALID_ADDRESS });
      const res = makeRes();
      await httpGetWalletHoldings(req, res, makeNext());

      const items: HoldingEntry[] = res.json.mock.calls[0][0].data.items;
      const alpha = items.find(i => i.creator_id === 'creator-alpha')!;
      expect(alpha.key_count).toBe('10');
      expect(alpha.total_value).toBe('5000');
   });

   it('creator-beta has correct key_count and total_value', async () => {
      jest
         .spyOn(walletHoldingsService, 'fetchWalletHoldings')
         .mockResolvedValue([
            [HOLDING_CREATOR_A, HOLDING_CREATOR_B, HOLDING_CREATOR_C],
            3,
         ]);

      const req = makeReq({ address: VALID_ADDRESS });
      const res = makeRes();
      await httpGetWalletHoldings(req, res, makeNext());

      const items: HoldingEntry[] = res.json.mock.calls[0][0].data.items;
      const beta = items.find(i => i.creator_id === 'creator-beta')!;
      expect(beta.key_count).toBe('5');
      expect(beta.total_value).toBe('1000');
   });

   it('creator-gamma has correct key_count and total_value', async () => {
      jest
         .spyOn(walletHoldingsService, 'fetchWalletHoldings')
         .mockResolvedValue([
            [HOLDING_CREATOR_A, HOLDING_CREATOR_B, HOLDING_CREATOR_C],
            3,
         ]);

      const req = makeReq({ address: VALID_ADDRESS });
      const res = makeRes();
      await httpGetWalletHoldings(req, res, makeNext());

      const items: HoldingEntry[] = res.json.mock.calls[0][0].data.items;
      const gamma = items.find(i => i.creator_id === 'creator-gamma')!;
      expect(gamma.key_count).toBe('3');
      expect(gamma.total_value).toBe('300');
   });

   // ── Creator not held by wallet is absent ──────────────────────────────────

   it('a creator not held by the wallet is absent from the response', async () => {
      jest
         .spyOn(walletHoldingsService, 'fetchWalletHoldings')
         .mockResolvedValue([
            [HOLDING_CREATOR_A, HOLDING_CREATOR_B, HOLDING_CREATOR_C],
            3,
         ]);

      const req = makeReq({ address: VALID_ADDRESS });
      const res = makeRes();
      await httpGetWalletHoldings(req, res, makeNext());

      const items: HoldingEntry[] = res.json.mock.calls[0][0].data.items;
      const notHeld = items.find(
         i => i.creator_id === HELD_CREATOR_ID_NOT_IN_RESPONSE
      );
      expect(notHeld).toBeUndefined();
   });

   // ── grand_total field ─────────────────────────────────────────────────────

   it('response includes a grand_total field', async () => {
      jest
         .spyOn(walletHoldingsService, 'fetchWalletHoldings')
         .mockResolvedValue([
            [HOLDING_CREATOR_A, HOLDING_CREATOR_B, HOLDING_CREATOR_C],
            3,
         ]);

      const req = makeReq({ address: VALID_ADDRESS });
      const res = makeRes();
      await httpGetWalletHoldings(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data).toHaveProperty('grand_total');
   });

   it('grand_total sums all total_value entries correctly', async () => {
      jest
         .spyOn(walletHoldingsService, 'fetchWalletHoldings')
         .mockResolvedValue([
            [HOLDING_CREATOR_A, HOLDING_CREATOR_B, HOLDING_CREATOR_C],
            3,
         ]);

      const req = makeReq({ address: VALID_ADDRESS });
      const res = makeRes();
      await httpGetWalletHoldings(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.grand_total).toBe(EXPECTED_GRAND_TOTAL);
   });

   it('grand_total is "0" when wallet has no holdings with total_value', async () => {
      const holdingNoValue: HoldingEntry = {
         creator_id: 'creator-no-price',
         creator_handle: 'no-price',
         key_count: '5',
         current_price: null,
         total_value: null,
      };
      jest
         .spyOn(walletHoldingsService, 'fetchWalletHoldings')
         .mockResolvedValue([[holdingNoValue], 1]);

      const req = makeReq({ address: VALID_ADDRESS });
      const res = makeRes();
      await httpGetWalletHoldings(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.grand_total).toBe('0');
   });

   it('grand_total is "0" when there are no holdings', async () => {
      jest
         .spyOn(walletHoldingsService, 'fetchWalletHoldings')
         .mockResolvedValue([[], 0]);

      const req = makeReq({ address: VALID_ADDRESS });
      const res = makeRes();
      await httpGetWalletHoldings(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.grand_total).toBe('0');
   });

   // ── full response shape validation ────────────────────────────────────────

   it('response data contains items, meta, and grand_total', async () => {
      jest
         .spyOn(walletHoldingsService, 'fetchWalletHoldings')
         .mockResolvedValue([
            [HOLDING_CREATOR_A, HOLDING_CREATOR_B, HOLDING_CREATOR_C],
            3,
         ]);

      const req = makeReq({ address: VALID_ADDRESS });
      const res = makeRes();
      await httpGetWalletHoldings(req, res, makeNext());

      const data = res.json.mock.calls[0][0].data;
      expect(data).toHaveProperty('items');
      expect(data).toHaveProperty('meta');
      expect(data).toHaveProperty('grand_total');
   });

   it('excludes creators with zero key holdings from the portfolio response', async () => {
      const zeroHolding: HoldingEntry = {
         creator_id: 'creator-zero',
         creator_handle: 'zero',
         key_count: '0',
         current_price: '250',
         total_value: '0',
      };

      jest
         .spyOn(walletHoldingsService, 'fetchWalletHoldings')
         .mockResolvedValue([
            [HOLDING_CREATOR_A, zeroHolding, HOLDING_CREATOR_B, HOLDING_CREATOR_C],
            4,
         ]);

      const req = makeReq({ address: VALID_ADDRESS });
      const res = makeRes();
      await httpGetWalletHoldings(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.items.some((item: HoldingEntry) => item.creator_id === 'creator-zero')).toBe(false);
      expect(body.data.grand_total).toBe(EXPECTED_GRAND_TOTAL);
   });

});
