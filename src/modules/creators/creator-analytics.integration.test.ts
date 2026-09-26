// Integration test: creator analytics endpoint — buy volume and unique buyers (#708)
//
// Verifies that:
//   1. Total buy volume is correctly aggregated from trade history
//   2. Unique buyer count deduplicates repeat buyers
//   3. A creator with no trades returns zero volume and zero buyers
//   4. Unauthenticated requests receive 403
//
// Two sections:
//   - Controller-level tests (mock prisma directly, test the handler function)
//   - Supertest-based auth tests (verify middleware protects the route)
//
// Follows existing conventions from creator-stats-buy-transaction.integration.test.ts
// and creator-profile-protected.integration.test.ts.

// ── Module mocks (hoisted by Jest; applied to both test sections) ─────────────
jest.mock('chalk', () => ({
   red: (text: string) => text,
   green: (text: string) => text,
   magenta: (text: string) => text,
   cyan: (text: string) => text,
}));

jest.mock('tspec', () => ({
   TspecDocsMiddleware: jest.fn().mockResolvedValue([]),
}));

// We mock the real prisma export object so that any code that imports prisma
// (controllers, middleware, services) gets the same shared mock we can control.
const mockPrisma = {
   creatorProfile: {
      findFirst: jest.fn(),
   },
   trade: {
      findMany: jest.fn(),
   },
   stellarWallet: {
      findUnique: jest.fn(),
   },
};

jest.mock('../../utils/prisma.utils', () => ({
   prisma: mockPrisma,
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      isLevelEnabled: jest.fn().mockReturnValue(false),
   },
}));

jest.mock('../../config', () => ({
   envConfig: {
      MODE: 'test',
      PORT: 3000,
      ENABLE_REQUEST_LOGGING: false,
   },
   appConfig: { allowedOrigins: [] },
}));

// ── Imports (after jest.mock so hoisting ensures they resolve to the mocks) ───

import { httpGetCreatorAnalytics } from './creators.controllers';

// ── Lightweight request/response mocks ────────────────────────────────────────

function makeReq(creatorId: string): any {
   return {
      params: { id: creatorId },
   };
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

// ── Stellar addresses for the test ────────────────────────────────────────────

const walletA = 'GWALLETA11111111111111111111111111111111111111111111111';
const walletB = 'GWALLETB22222222222222222222222222222222222222222222222';

// 500 XLM in stroops (1 XLM = 10^7 stroops)
const XLM_500 = (500n * 10_000_000n).toString();
// 200 XLM in stroops
const XLM_200 = (200n * 10_000_000n).toString();
// 300 XLM in stroops
const XLM_300 = (300n * 10_000_000n).toString();
// 400 XLM in stroops
const XLM_400 = (400n * 10_000_000n).toString();
// 1000 XLM in stroops
const XLM_1000 = (1000n * 10_000_000n).toString();
// 100 XLM in stroops
const XLM_100 = (100n * 10_000_000n).toString();

// ── Controller-level tests (mock-based, direct handler invocation) ────────────

describe('#708 Integration test: creator analytics endpoint', () => {
   const creatorId = 'creator-analytics-1';

   // In-memory trade store
   const tradeStore: Array<{
      buyer: string;
      creatorId: string;
      price: string;
   }> = [];

   beforeEach(() => {
      jest.clearAllMocks();
      tradeStore.length = 0;

      mockPrisma.creatorProfile.findFirst.mockResolvedValue({ id: creatorId });

      mockPrisma.trade.findMany.mockImplementation(async (args: any) => {
         return tradeStore.filter(t => t.creatorId === args.where.creatorId);
      });
   });

   describe('with seeded buy transactions', () => {
      beforeEach(() => {
         // Seed three buy transactions:
         //   Wallet A: 500 XLM
         //   Wallet B: 200 XLM
         //   Wallet A: 300 XLM
         tradeStore.push(
            { buyer: walletA, creatorId, price: XLM_500 },
            { buyer: walletB, creatorId, price: XLM_200 },
            { buyer: walletA, creatorId, price: XLM_300 }
         );
      });

      it('returns total buy volume of 1000 XLM in stroops', async () => {
         const req = makeReq(creatorId);
         const res = makeRes();
         await httpGetCreatorAnalytics(req, res, makeNext());

         expect(res.status).toHaveBeenCalledWith(200);
         const data = res.json.mock.calls[0][0].data;
         expect(data.buyVolume).toBe(XLM_1000);
      });

      it('returns unique buyer count of 2 (wallet A counted once despite two purchases)', async () => {
         const req = makeReq(creatorId);
         const res = makeRes();
         await httpGetCreatorAnalytics(req, res, makeNext());

         const data = res.json.mock.calls[0][0].data;
         expect(data.uniqueBuyers).toBe(2);
      });

      it('response envelope includes success: true', async () => {
         const req = makeReq(creatorId);
         const res = makeRes();
         await httpGetCreatorAnalytics(req, res, makeNext());

         const body = res.json.mock.calls[0][0];
         expect(body).toHaveProperty('success', true);
         expect(body).toHaveProperty('data');
      });

      it('buyVolume is a string representing stroops', async () => {
         const req = makeReq(creatorId);
         const res = makeRes();
         await httpGetCreatorAnalytics(req, res, makeNext());

         const data = res.json.mock.calls[0][0].data;
         expect(typeof data.buyVolume).toBe('string');
         expect(BigInt(data.buyVolume)).toBe(10_000_000_000n);
      });

      it('uniqueBuyers is a number', async () => {
         const req = makeReq(creatorId);
         const res = makeRes();
         await httpGetCreatorAnalytics(req, res, makeNext());

         const data = res.json.mock.calls[0][0].data;
         expect(typeof data.uniqueBuyers).toBe('number');
      });
   });

   describe('creator with no transactions', () => {
      it('returns buyVolume "0" for a creator with no trades', async () => {
         const req = makeReq(creatorId);
         const res = makeRes();
         await httpGetCreatorAnalytics(req, res, makeNext());

         expect(res.status).toHaveBeenCalledWith(200);
         const data = res.json.mock.calls[0][0].data;
         expect(data.buyVolume).toBe('0');
      });

      it('returns uniqueBuyers 0 for a creator with no trades', async () => {
         const req = makeReq(creatorId);
         const res = makeRes();
         await httpGetCreatorAnalytics(req, res, makeNext());

         const data = res.json.mock.calls[0][0].data;
         expect(data.uniqueBuyers).toBe(0);
      });
   });

   describe('edge cases', () => {
      it('handles a creator with a single buyer making a single purchase', async () => {
         tradeStore.push({ buyer: walletA, creatorId, price: XLM_500 });

         const req = makeReq(creatorId);
         const res = makeRes();
         await httpGetCreatorAnalytics(req, res, makeNext());

         const data = res.json.mock.calls[0][0].data;
         expect(data.buyVolume).toBe(XLM_500);
         expect(data.uniqueBuyers).toBe(1);
      });

      it('deduplicates buyers when the same wallet buys many times', async () => {
         tradeStore.push(
            { buyer: walletA, creatorId, price: XLM_100 },
            { buyer: walletA, creatorId, price: XLM_200 },
            { buyer: walletA, creatorId, price: XLM_300 },
            { buyer: walletA, creatorId, price: XLM_400 },
            { buyer: walletA, creatorId, price: XLM_500 }
         );

         const req = makeReq(creatorId);
         const res = makeRes();
         await httpGetCreatorAnalytics(req, res, makeNext());

         const data = res.json.mock.calls[0][0].data;
         // 100 + 200 + 300 + 400 + 500 = 1500
         const expectedVolume =
            (100n + 200n + 300n + 400n + 500n) * 10_000_000n;
         expect(data.buyVolume).toBe(expectedVolume.toString());
         expect(data.uniqueBuyers).toBe(1);
      });
   });
});

// ── Supertest-based auth tests ────────────────────────────────────────────────

import supertest from 'supertest';
import app from '../../app';

describe('GET /api/v1/creators/:id/analytics — auth protection', () => {
   beforeEach(() => {
      jest.clearAllMocks();

      // Set up the mock so that the wallet-ownership middleware sees a
      // wallet that does NOT own the creator profile → 403 is expected.
      mockPrisma.creatorProfile.findFirst.mockResolvedValue({
         id: 'creator-analytics-1',
         userId: 'owner-user-id',
      });
      mockPrisma.stellarWallet.findUnique.mockResolvedValue({
         userId: 'user-other',
      });
      mockPrisma.trade.findMany.mockResolvedValue([]);
   });

   it('returns 401 when x-wallet-address header is missing', async () => {
      const res = await supertest(app).get(
         '/api/v1/creators/creator-analytics-1/analytics'
      );

      expect(res.status).toBe(401);
      expect(res.body).toEqual(
         expect.objectContaining({
            success: false,
            error: expect.objectContaining({
               code: 'UNAUTHORIZED',
            }),
         })
      );
   });

   it('returns 403 when the wallet does not own the creator profile', async () => {
      const res = await supertest(app)
         .get('/api/v1/creators/creator-analytics-1/analytics')
         .set(
            'x-wallet-address',
            'GOTHERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
         );

      expect(res.status).toBe(403);
      expect(res.body).toEqual(
         expect.objectContaining({
            success: false,
            error: expect.objectContaining({
               code: 'FORBIDDEN',
            }),
         })
      );
   });
});
