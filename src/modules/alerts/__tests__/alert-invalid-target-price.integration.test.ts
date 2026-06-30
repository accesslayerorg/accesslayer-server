// Integration test: POST /api/v1/alerts returns 400 when target_price is zero or
// negative (#549)
//
// A price alert with a zero or negative target price is meaningless.  The
// registration endpoint must reject these values with a 400 *before* writing
// anything to the database.
//
// Uses Jest mocks — no live database connection is required.

import { httpCreateAlert } from '../alert.controllers';

// ── Lightweight request / response mocks ──────────────────────────────────────

const VALID_PAYLOAD = {
   creator_id: 'creator-abc-123',
   wallet_address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
   target_price: 100,
   direction: 'above',
   callback_url: 'https://example.com/webhook',
};

function makeReq(body: Record<string, unknown> = {}): any {
   return { body };
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

// ── Mock the alert service so no DB writes occur ───────────────────────────────

jest.mock('../alert.service', () => ({
   createAlert: jest.fn(),
   listAlerts: jest.fn(),
   deleteAlert: jest.fn(),
}));

import { createAlert } from '../alert.service';

const mockCreateAlert = createAlert as jest.Mock;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/v1/alerts — zero or negative target_price (#549)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   // Acceptance criterion: zero target_price returns 400
   it('returns 400 when target_price is zero', async () => {
      const req = makeReq({ ...VALID_PAYLOAD, target_price: 0 });
      const res = makeRes();
      await httpCreateAlert(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(400);
   });

   // Acceptance criterion: negative target_price returns 400
   it('returns 400 when target_price is negative (-1)', async () => {
      const req = makeReq({ ...VALID_PAYLOAD, target_price: -1 });
      const res = makeRes();
      await httpCreateAlert(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(400);
   });

   it('returns 400 when target_price is a large negative number', async () => {
      const req = makeReq({ ...VALID_PAYLOAD, target_price: -9999 });
      const res = makeRes();
      await httpCreateAlert(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(400);
   });

   // Acceptance criterion: error body identifies the target_price field
   it('error body identifies the target_price field when target_price is zero', async () => {
      const req = makeReq({ ...VALID_PAYLOAD, target_price: 0 });
      const res = makeRes();
      await httpCreateAlert(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body).toBeDefined();

      // The response must reference 'target_price' either in a field array
      // or in the top-level message.
      const bodyStr = JSON.stringify(body);
      expect(bodyStr).toMatch(/target_price/);
   });

   it('error body identifies the target_price field when target_price is negative', async () => {
      const req = makeReq({ ...VALID_PAYLOAD, target_price: -1 });
      const res = makeRes();
      await httpCreateAlert(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      const bodyStr = JSON.stringify(body);
      expect(bodyStr).toMatch(/target_price/);
   });

   // Acceptance criterion: no alert record created after failed request
   it('does not call createAlert when target_price is zero', async () => {
      const req = makeReq({ ...VALID_PAYLOAD, target_price: 0 });
      const res = makeRes();
      await httpCreateAlert(req, res, makeNext());

      expect(mockCreateAlert).not.toHaveBeenCalled();
   });

   it('does not call createAlert when target_price is negative', async () => {
      const req = makeReq({ ...VALID_PAYLOAD, target_price: -1 });
      const res = makeRes();
      await httpCreateAlert(req, res, makeNext());

      expect(mockCreateAlert).not.toHaveBeenCalled();
   });

   // Sanity check: a valid positive target_price still reaches createAlert
   it('does not return 400 when target_price is a valid positive number', async () => {
      mockCreateAlert.mockResolvedValue({ id: 'alert-1', ...VALID_PAYLOAD });

      const req = makeReq({ ...VALID_PAYLOAD, target_price: 50 });
      const res = makeRes();
      await httpCreateAlert(req, res, makeNext());

      expect(res.status).not.toHaveBeenCalledWith(400);
      expect(mockCreateAlert).toHaveBeenCalled();
   });
});
