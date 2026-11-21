// Unit tests: wallet-scoped JWT guards
//
// Covers the auth acceptance criteria:
//   - analytics: 403 when the JWT wallet is not the key creator
//   - users routes: 401 when the JWT wallet does not match the path param

jest.mock('../utils/prisma.utils', () => ({
   prisma: {
      stellarWallet: { findUnique: jest.fn() },
      creatorProfile: { findFirst: jest.fn() },
   },
}));

import { prisma } from '../utils/prisma.utils';
import {
   requireJwtAuth,
   requireKeyCreator,
   requireWalletParamMatch,
   AuthenticatedRequest,
} from './jwt-auth.middleware';
import { signWalletAccessToken } from '../utils/jwt.utils';

const walletFindUnique = prisma.stellarWallet.findUnique as jest.Mock;
const creatorFindFirst = prisma.creatorProfile.findFirst as jest.Mock;

const WALLET_A = 'GA5XIGA5C7GTGTW7ZKJ4YV6OEILUY2Q7YIHZQNNDJUWAVES4O7D5SUK9';
const WALLET_B = 'GBRPYHAL2FCCNNGSJCJ2OOJ6MOL2RLUVTDMYNOOWGGVJXC7UE5ABSCJL';

function makeReq(overrides: Record<string, unknown> = {}): AuthenticatedRequest {
   return {
      headers: {},
      params: {},
      ...overrides,
   } as unknown as AuthenticatedRequest;
}

function makeRes() {
   const res: any = {};
   res.statusCode = 200;
   res.headersSent = false;
   res.status = jest.fn().mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
   });
   res.json = jest.fn().mockReturnValue(res);
   res.setHeader = jest.fn().mockReturnValue(res);
   res.set = jest.fn().mockReturnValue(res);
   return res;
}

describe('requireJwtAuth', () => {
   it('returns 401 with no Authorization header', () => {
      const req = makeReq();
      const res = makeRes();
      const next = jest.fn();

      requireJwtAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
   });

   it('returns 401 for a malformed Authorization header', () => {
      const req = makeReq({ headers: { authorization: 'Token abc' } });
      const res = makeRes();
      const next = jest.fn();

      requireJwtAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
   });

   it('attaches the wallet claim and continues for a valid token', () => {
      const token = signWalletAccessToken(WALLET_A);
      const req = makeReq({
         headers: { authorization: `Bearer ${token}` },
      });
      const res = makeRes();
      const next = jest.fn();

      requireJwtAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user?.wallet).toBe(WALLET_A);
   });

   it('returns 401 TOKEN_ERROR for an invalid token signature', () => {
      const req = makeReq({
         headers: { authorization: 'Bearer not.a.jwt' },
      });
      const res = makeRes();
      const next = jest.fn();

      requireJwtAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
         expect.objectContaining({
            error: expect.objectContaining({ code: 'TOKEN_ERROR' }),
         })
      );
      expect(next).not.toHaveBeenCalled();
   });
});

describe('requireWalletParamMatch', () => {
   function run(walletParam: string, token?: string) {
      const req = makeReq({
         params: { wallet: walletParam },
         headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      const res = makeRes();
      const next = jest.fn();
      requireWalletParamMatch('wallet')(req as never, res as never, next);
      return { req, res, next };
   }

   it('continues when the JWT wallet matches the path param', async () => {
      const token = signWalletAccessToken(WALLET_A);
      const { res, next } = await Promise.resolve(run(WALLET_A, token));

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalledWith(401);
   });

   it('returns 401 when the JWT wallet does not match the path param', async () => {
      const token = signWalletAccessToken(WALLET_B);
      const { res, next } = await Promise.resolve(run(WALLET_A, token));

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
   });

   it('returns 401 without a token', async () => {
      const { res, next } = await Promise.resolve(run(WALLET_A));

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
   });
});

describe('requireKeyCreator', () => {
   function run(keyId: string, token?: string) {
      const req = makeReq({
         params: { keyId },
         headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      const res = makeRes();
      const next = jest.fn();
      let resolveDone: () => void = () => undefined;
      const done = new Promise<void>((resolve) => {
         resolveDone = resolve;
      });
      // Error paths respond without calling next, so settle on either.
      const originalJson = res.json;
      res.json = (...args: unknown[]) => {
         resolveDone();
         return originalJson(...(args as [unknown]));
      };
      const guard = requireKeyCreator('keyId');
      void guard(req as never, res as never, () => {
         next();
         resolveDone();
      });
      return { req, res, next, done };
   }

   beforeEach(() => {
      walletFindUnique.mockReset();
      creatorFindFirst.mockReset();
   });

   it('continues when the JWT wallet belongs to the key creator', async () => {
      creatorFindFirst.mockResolvedValue({ userId: 'user-1' });
      walletFindUnique.mockResolvedValue({ userId: 'user-1' });
      const token = signWalletAccessToken(WALLET_A);

      const { res, next, done } = run('key-1', token);
      await done;

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalledWith(403);
   });

   it('returns 403 when the JWT wallet is not the key creator', async () => {
      creatorFindFirst.mockResolvedValue({ userId: 'user-creator' });
      walletFindUnique.mockResolvedValue({ userId: 'user-other' });
      const token = signWalletAccessToken(WALLET_B);

      const { res, next, done } = run('key-1', token);
      await done;

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
   });

   it('returns 401 when the wallet is not registered', async () => {
      creatorFindFirst.mockResolvedValue({ userId: 'user-creator' });
      walletFindUnique.mockResolvedValue(null);
      const token = signWalletAccessToken(WALLET_B);

      const { res, next, done } = run('key-1', token);
      await done;

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
   });

   it('returns 404 when no creator profile exists for the key', async () => {
      creatorFindFirst.mockResolvedValue(null);
      const token = signWalletAccessToken(WALLET_A);

      const { res, next, done } = run('missing-key', token);
      await done;

      expect(res.status).toHaveBeenCalledWith(404);
      expect(next).not.toHaveBeenCalled();
   });
});
