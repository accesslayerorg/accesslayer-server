import { AuthenticatedRequest } from '../../middlewares/jwt-auth.middleware';
import {
   createAutoInvestRule,
   deleteAutoInvestRule,
   evaluateListing,
   getAutoInvestRule,
   listActiveAutoInvestRules,
   updateAutoInvestRule,
} from './auto-invest.service';
import {
   httpCreateAutoInvestRule,
   httpDeleteAutoInvestRule,
   httpEvaluateListing,
   httpListAutoInvestRules,
   httpUpdateAutoInvestRule,
} from './auto-invest.controllers';

jest.mock('./auto-invest.service', () => ({
   createAutoInvestRule: jest.fn(),
   deleteAutoInvestRule: jest.fn(),
   evaluateListing: jest.fn(),
   getAutoInvestRule: jest.fn(),
   listActiveAutoInvestRules: jest.fn(),
   updateAutoInvestRule: jest.fn(),
}));

const WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASH';

function makeReq(
   userWallet: string = WALLET,
   overrides: { query?: any; body?: any; params?: any } = {}
): AuthenticatedRequest {
   return {
      user: { wallet: userWallet },
      query: overrides.query ?? {},
      body: overrides.body ?? {},
      params: overrides.params ?? {},
   } as unknown as AuthenticatedRequest;
}

const OTHER_WALLET = 'G' + 'A'.repeat(54) + 'B';
const RULE_ID = 'caaaaaaaaaaaaaaaaaaaaaaaa';

function makeRes() {
   const res: any = {
      statusCode: 200,
      status: jest.fn(function (this: any, code: number) {
         this.statusCode = code;
         return this;
      }),
      json: jest.fn().mockReturnThis(),
   };
   return res;
}

describe('auto-invest controllers', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('httpCreateAutoInvestRule', () => {
      it('creates a rule and returns 201', async () => {
         const req = makeReq(WALLET, {
            body: { category: 'music', minRating: null, maxPrice: '5', maxPerKey: 1 },
         });
         const res = makeRes();
         const next = jest.fn();
         (createAutoInvestRule as jest.Mock).mockResolvedValue({
            id: 'caaaaaaaaaaaaaaaaaaaaaaaa',
            walletAddress: WALLET,
            category: 'music',
            minRating: null,
            maxPrice: '5',
            maxPerKey: 1,
            isActive: true,
         });

         await httpCreateAutoInvestRule(req, res, next);

         expect(createAutoInvestRule).toHaveBeenCalledWith(WALLET, {
            category: 'music',
            minRating: null,
            maxPrice: '5',
            maxPerKey: 1,
         });
         expect(res.statusCode).toBe(201);
         expect(next).not.toHaveBeenCalled();
      });

      it('returns 400 on invalid fields', async () => {
         const req = makeReq(WALLET, { body: { category: '', maxPrice: 'abc' } });
         const res = makeRes();
         const next = jest.fn();

         await httpCreateAutoInvestRule(req, res, next);

         expect(res.statusCode).toBe(400);
         expect(createAutoInvestRule).not.toHaveBeenCalled();
         expect(next).not.toHaveBeenCalled();
      });
   });

   describe('httpListAutoInvestRules', () => {
      it('lists active rules for the authorized wallet', async () => {
         const req = makeReq(WALLET, { query: { wallet: WALLET } });
         const res = makeRes();
         const next = jest.fn();
         (listActiveAutoInvestRules as jest.Mock).mockResolvedValue([
            { id: 'caaaaaaaaaaaaaaaaaaaaaaaa', walletAddress: WALLET, isActive: true },
         ]);

         await httpListAutoInvestRules(req, res, next);

         expect(listActiveAutoInvestRules).toHaveBeenCalledWith(WALLET);
         expect(res.statusCode).toBe(200);
         expect(res.json).toHaveBeenCalled();
      });

      it('rejects when the wallet param does not match the authenticated wallet', async () => {
         const req = makeReq(WALLET, { query: { wallet: OTHER_WALLET } });
         const res = makeRes();
         const next = jest.fn();

         await httpListAutoInvestRules(req, res, next);

         expect(res.statusCode).toBe(403);
         expect(listActiveAutoInvestRules).not.toHaveBeenCalled();
      });

      it('returns 400 when wallet query is missing', async () => {
         const req = makeReq(WALLET, { query: {} });
         const res = makeRes();
         const next = jest.fn();

         await httpListAutoInvestRules(req, res, next);

         expect(res.statusCode).toBe(400);
         expect(listActiveAutoInvestRules).not.toHaveBeenCalled();
      });
   });

   describe('httpUpdateAutoInvestRule', (): void => {
      it('partially updates preserving unspecified values', async () => {
         const req = makeReq(WALLET, {
            params: { id: 'caaaaaaaaaaaaaaaaaaaaaaaa' },
            body: { isActive: false },
         });
         const res = makeRes();
         const next = jest.fn();
         (getAutoInvestRule as jest.Mock).mockResolvedValue({
            id: 'caaaaaaaaaaaaaaaaaaaaaaaa',
            walletAddress: WALLET,
            category: 'music',
            minRating: null,
            maxPrice: '5',
            maxPerKey: 1,
            isActive: true,
         });
         (updateAutoInvestRule as jest.Mock).mockResolvedValue({
            id: 'caaaaaaaaaaaaaaaaaaaaaaaa',
            walletAddress: WALLET,
            category: 'music',
            minRating: null,
            maxPrice: '5',
            maxPerKey: 1,
            isActive: false,
         });

         await httpUpdateAutoInvestRule(req, res, next);

         expect(updateAutoInvestRule).toHaveBeenCalledWith('caaaaaaaaaaaaaaaaaaaaaaaa', WALLET, {
            category: undefined,
            minRating: null,
            maxPrice: undefined,
            maxPerKey: undefined,
            isActive: false,
         });
         expect(res.statusCode).toBe(200);
      });

      it('returns 404 for a rule owned by another wallet', async () => {
         const req = makeReq(WALLET, {
            params: { id: 'caaaaaaaaaaaaaaaaaaaaaaaa' },
            body: { isActive: false },
         });
         const res = makeRes();
         const next = jest.fn();
         (getAutoInvestRule as jest.Mock).mockResolvedValue(null);

         await httpUpdateAutoInvestRule(req, res, next);

         expect(res.statusCode).toBe(404);
         expect(updateAutoInvestRule).not.toHaveBeenCalled();
      });

      it('returns 404 for a nonexistent rule', async () => {
         const req = makeReq(WALLET, {
            params: { id: RULE_ID },
            body: { isActive: false },
         });
         const res = makeRes();
         const next = jest.fn();
         (getAutoInvestRule as jest.Mock).mockResolvedValue(null);

         await httpUpdateAutoInvestRule(req, res, next);

         expect(res.statusCode).toBe(404);
      });
   });

   describe('httpDeleteAutoInvestRule', () => {
      it('deletes a rule owned by the wallet', async () => {
         const req = makeReq(WALLET, { params: { id: 'caaaaaaaaaaaaaaaaaaaaaaaa' } });
         const res = makeRes();
         (deleteAutoInvestRule as jest.Mock).mockResolvedValue(true);

         await httpDeleteAutoInvestRule(req, res);

         expect(deleteAutoInvestRule).toHaveBeenCalledWith('caaaaaaaaaaaaaaaaaaaaaaaa', WALLET);
         expect(res.statusCode).toBe(200);
      });

      it('returns 404 for a rule not owned by the wallet', async () => {
         const req = makeReq(WALLET, { params: { id: 'caaaaaaaaaaaaaaaaaaaaaaaa' } });
         const res = makeRes();
         (deleteAutoInvestRule as jest.Mock).mockResolvedValue(false);

         await httpDeleteAutoInvestRule(req, res);

         expect(res.statusCode).toBe(404);
      });
   });

   describe('httpEvaluateListing', () => {
      it('triggers evaluation and returns the result', async () => {
         const req = makeReq(WALLET, { params: { listingId: 'creator-1' } });
         const res = makeRes();
         const next = jest.fn();
         (evaluateListing as jest.Mock).mockResolvedValue({
            listingId: 'creator-1',
            evaluated: 1,
            executed: 1,
            skipped: 0,
            failed: 0,
            results: [],
         });

         await httpEvaluateListing(req, res, next);

         expect(evaluateListing).toHaveBeenCalledWith('creator-1');
         expect(res.statusCode).toBe(200);
      });
   });
});
