import express from 'express';
import request from 'supertest';
import { StrKey } from '@stellar/stellar-base';
import tipsRouter from './tips.routes';
import votingWeightRouter from '../governance/governance-voting-weight.routes';
import { getTipLeaderboard } from './tip-leaderboard.service';
import { getWalletVotingWeight } from '../governance/governance-voting-weight.service';

jest.mock('./tip-leaderboard.service', () => ({ getTipLeaderboard: jest.fn() }));
jest.mock('../governance/governance-voting-weight.service', () => ({ getWalletVotingWeight: jest.fn() }));

const app = express();
app.use('/keys', tipsRouter);
app.use('/governance', votingWeightRouter);
const wallet = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));

describe('voting weight and tipping HTTP contracts', () => {
   beforeEach(() => jest.clearAllMocks());

   it('returns the leaderboard in the standard success envelope', async () => {
      (getTipLeaderboard as jest.Mock).mockResolvedValue([]);
      const response = await request(app).get('/keys/key-1/tips/leaderboard?limit=10');
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
      expect(getTipLeaderboard).toHaveBeenCalledWith('key-1', 10);
      expect(response.headers['cache-control']).toContain('no-store');
   });

   it.each(['0', '101', '1.5', 'abc'])('rejects leaderboard limit %s', async limit => {
      const response = await request(app).get('/keys/key-1/tips/leaderboard?limit=' + limit);
      expect(response.status).toBe(400);
      expect(getTipLeaderboard).not.toHaveBeenCalled();
   });

   it('rejects duplicate limit query parameters', async () => {
      expect((await request(app).get('/keys/key-1/tips/leaderboard?limit=2&limit=3')).status).toBe(400);
   });

   it('returns all voting weight fields for a checksummed wallet', async () => {
      const result = { own_weight: '0', delegated_weight: '0', total: '0', delegators: [] };
      (getWalletVotingWeight as jest.Mock).mockResolvedValue(result);
      const response = await request(app).get('/governance/voting-weight/' + wallet + '/key-1');
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(result);
      expect(getWalletVotingWeight).toHaveBeenCalledWith(wallet, 'key-1');
      expect(response.headers['cache-control']).toBe('no-store');
   });

   it('rejects an invalid wallet before any database lookup', async () => {
      expect((await request(app).get('/governance/voting-weight/GINVALID/key-1')).status).toBe(400);
      expect(getWalletVotingWeight).not.toHaveBeenCalled();
   });
});
