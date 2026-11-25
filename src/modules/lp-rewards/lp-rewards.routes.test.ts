import express from 'express';
import request from 'supertest';
import { signWalletAccessToken } from '../../utils/jwt.utils';
import router from './lp-rewards.routes';
import {
   claimKeyLpRewards,
   ConcurrentClaimError,
   getKeyLpPosition,
   KeyLpPositionNotFoundError,
   LpRewardsKeyNotFoundError,
   NothingToClaimError,
} from './lp-rewards.service';

jest.mock('./lp-rewards.service', () => {
   class LpRewardsKeyNotFoundError extends Error {}
   class KeyLpPositionNotFoundError extends Error {}
   class NothingToClaimError extends Error {
      constructor() {
         super('No claimable LP rewards');
      }
   }
   class ConcurrentClaimError extends Error {
      constructor() {
         super('A concurrent claim is already in progress for this position');
      }
   }
   return {
      getKeyLpPosition: jest.fn(),
      claimKeyLpRewards: jest.fn(),
      LpRewardsKeyNotFoundError,
      KeyLpPositionNotFoundError,
      NothingToClaimError,
      ConcurrentClaimError,
   };
});

const getPosition = getKeyLpPosition as jest.Mock;
const claim = claimKeyLpRewards as jest.Mock;
const WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const app = express();
app.use(express.json());
app.use('/api/v1/keys', router);
app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => {
   res.status(500).json({ success: false });
});

function token(wallet: string): string {
   return signWalletAccessToken(wallet);
}

describe('GET /keys/:keyId/lp/:wallet', () => {
   beforeEach(() => jest.clearAllMocks());

   it('returns the position view', async () => {
      getPosition.mockResolvedValue({ lpTokens: '10.0000000', poolSharePct: '50.0000', accruedRewards: '7', claimable: '7' });
      const res = await request(app).get(`/api/v1/keys/key-1/lp/${WALLET}`);
      expect(res.status).toBe(200);
      expect(getPosition).toHaveBeenCalledWith('key-1', WALLET);
      expect(res.body.data).toMatchObject({ poolSharePct: '50.0000', claimable: '7' });
   });

   it('rejects an invalid wallet', async () => {
      const res = await request(app).get('/api/v1/keys/key-1/lp/not-a-wallet');
      expect(res.status).toBe(400);
      expect(getPosition).not.toHaveBeenCalled();
   });

   it.each([
      [new LpRewardsKeyNotFoundError('k'), 'Key not found'],
      [new KeyLpPositionNotFoundError('k', WALLET), 'LP position not found'],
   ])('maps %s to 404', async (error, message) => {
      getPosition.mockRejectedValue(error);
      const res = await request(app).get(`/api/v1/keys/key-1/lp/${WALLET}`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).toContain(message);
   });

   it('forwards unexpected errors', async () => {
      getPosition.mockRejectedValue(new Error('db down'));
      const res = await request(app).get(`/api/v1/keys/key-1/lp/${WALLET}`);
      expect(res.status).toBe(500);
   });
});

describe('POST /keys/:keyId/lp/:wallet/claim', () => {
   beforeEach(() => jest.clearAllMocks());

   it('requires authentication', async () => {
      const res = await request(app).post(`/api/v1/keys/key-1/lp/${WALLET}/claim`);
      expect(res.status).toBe(401);
      expect(claim).not.toHaveBeenCalled();
   });

   it('rejects a token for a different wallet', async () => {
      const res = await request(app)
         .post(`/api/v1/keys/key-1/lp/${WALLET}/claim`)
         .set('Authorization', `Bearer ${token(OTHER)}`);
      expect(res.status).toBe(401);
      expect(claim).not.toHaveBeenCalled();
   });

   it('claims for the authenticated wallet', async () => {
      claim.mockResolvedValue({ claimId: 'c1', amount: '7', claimable: '0', status: 'pending' });
      const res = await request(app)
         .post(`/api/v1/keys/key-1/lp/${WALLET}/claim`)
         .set('Authorization', `Bearer ${token(WALLET)}`);
      expect(res.status).toBe(200);
      expect(claim).toHaveBeenCalledWith('key-1', WALLET);
      expect(res.body.data).toMatchObject({ amount: '7', claimable: '0' });
   });

   it.each([new NothingToClaimError(), new ConcurrentClaimError()])('maps %s to 409', async error => {
      claim.mockRejectedValue(error);
      const res = await request(app)
         .post(`/api/v1/keys/key-1/lp/${WALLET}/claim`)
         .set('Authorization', `Bearer ${token(WALLET)}`);
      expect(res.status).toBe(409);
   });

   it('maps a missing position to 404', async () => {
      claim.mockRejectedValue(new KeyLpPositionNotFoundError('k', WALLET));
      const res = await request(app)
         .post(`/api/v1/keys/key-1/lp/${WALLET}/claim`)
         .set('Authorization', `Bearer ${token(WALLET)}`);
      expect(res.status).toBe(404);
   });
});
