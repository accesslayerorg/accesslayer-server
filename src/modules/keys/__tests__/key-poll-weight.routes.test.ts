// src/modules/keys/__tests__/key-poll-weight.routes.test.ts
import express from 'express';
import request from 'supertest';
import keysRouter from '../keys.routes';
import { KeyNotFoundError } from '../key-fees.service';
import {
   getKeyPollWeight,
   PollNotFoundError,
} from '../key-poll-weight.service';

jest.mock('../key-poll-weight.service', () => {
   const actual = jest.requireActual('../key-poll-weight.service');
   return {
      getKeyPollWeight: jest.fn(),
      KeyNotFoundError: actual.KeyNotFoundError,
      PollNotFoundError: actual.PollNotFoundError,
   };
});

const mockGetKeyPollWeight = getKeyPollWeight as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/v1/keys', keysRouter);

describe('GET /api/v1/keys/:keyId/polls/:pollId/weight/:wallet', () => {
   const KEY_ID = 'creator-1';
   const POLL_ID = 'poll-99';
   const WALLET = 'GAVOTER123456789';

   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('returns 200 with vote_weight and snapshot_block on success', async () => {
      mockGetKeyPollWeight.mockResolvedValueOnce({
         key_id: KEY_ID,
         poll_id: POLL_ID,
         wallet: WALLET,
         vote_weight: '75',
         snapshot_block: 54321,
      });

      const res = await request(app).get(
         `/api/v1/keys/${KEY_ID}/polls/${POLL_ID}/weight/${WALLET}`
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({
         key_id: KEY_ID,
         poll_id: POLL_ID,
         wallet: WALLET,
         vote_weight: '75',
         snapshot_block: 54321,
      });
      expect(mockGetKeyPollWeight).toHaveBeenCalledWith(KEY_ID, POLL_ID, WALLET);
   });

   it('returns 404 when key is not found', async () => {
      mockGetKeyPollWeight.mockRejectedValueOnce(
         new KeyNotFoundError('Key not found')
      );

      const res = await request(app).get(
         `/api/v1/keys/non-existent/polls/${POLL_ID}/weight/${WALLET}`
      );

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
   });

   it('returns 404 when poll is not found', async () => {
      mockGetKeyPollWeight.mockRejectedValueOnce(
         new PollNotFoundError('Poll not found')
      );

      const res = await request(app).get(
         `/api/v1/keys/${KEY_ID}/polls/non-existent/weight/${WALLET}`
      );

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
   });
});
