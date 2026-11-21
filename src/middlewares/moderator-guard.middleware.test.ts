import { envConfig } from '../config';
import { signWalletAccessToken } from '../utils/jwt.utils';
import {
   isModeratorWallet,
   parseModeratorWallets,
   requireModerator,
} from './moderator-guard.middleware';

const MODERATOR = `G${'M'.repeat(55)}`;
const OTHER = `G${'O'.repeat(55)}`;

function makeRes(): any {
   const res: any = {};
   res.status = jest.fn().mockReturnValue(res);
   res.json = jest.fn().mockReturnValue(res);
   res.setHeader = jest.fn();
   return res;
}

function makeReq(token?: string): any {
   return {
      headers: token ? { authorization: `Bearer ${token}` } : {},
   };
}

describe('moderator guard', () => {
   const original = envConfig.MODERATOR_WALLETS;

   beforeEach(() => {
      envConfig.MODERATOR_WALLETS = ` ${MODERATOR} , ,GSECOND `;
   });

   afterAll(() => {
      envConfig.MODERATOR_WALLETS = original;
   });

   it('parses a comma-separated allowlist, trimming blanks', () => {
      expect(parseModeratorWallets(envConfig.MODERATOR_WALLETS)).toEqual(
         new Set([MODERATOR.toLowerCase(), 'gsecond'])
      );
      expect(parseModeratorWallets(undefined).size).toBe(0);
   });

   it('matches wallets case-insensitively', () => {
      expect(isModeratorWallet(MODERATOR.toLowerCase())).toBe(true);
      expect(isModeratorWallet(OTHER)).toBe(false);
      expect(isModeratorWallet(undefined)).toBe(false);
   });

   it('calls next for a moderator wallet', () => {
      const req = makeReq(signWalletAccessToken(MODERATOR));
      const res = makeRes();
      const next = jest.fn();
      requireModerator(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user.wallet).toBe(MODERATOR);
   });

   it('returns 403 for an authenticated non-moderator wallet', () => {
      const res = makeRes();
      const next = jest.fn();
      requireModerator(makeReq(signWalletAccessToken(OTHER)), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
   });

   it('returns 401 without a token', () => {
      const res = makeRes();
      const next = jest.fn();
      requireModerator(makeReq(), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
   });
});
