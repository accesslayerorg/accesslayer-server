// Route tests: GET /keys/:keyId/polls/:pollId/weight/:wallet (#1154)
// Service is mocked; the in-memory Redis stub proves the cache is applied.

const mockCacheStore = new Map<string, string>();
const mockTtls: number[] = [];

jest.mock('../../utils/redis.utils', () => {
   const actual = jest.requireActual('../../utils/redis.utils');
   return {
      ...actual,
      cacheGetJson: jest.fn(async (key: string) => {
         const raw = mockCacheStore.get(key);
         return raw === undefined ? null : JSON.parse(raw);
      }),
      cacheSetJson: jest.fn(
         async (key: string, value: unknown, ttlSeconds: number) => {
            mockCacheStore.set(key, JSON.stringify(value));
            mockTtls.push(ttlSeconds);
         }
      ),
   };
});

jest.mock('./key-poll-weight.service', () => {
   const actual = jest.requireActual('./key-poll-weight.service');
   return {
      ...actual,
      getPollVoteWeight: jest.fn(),
   };
});

import express from 'express';
import request from 'supertest';
import keysRouter from './keys.routes';
import {
   getPollVoteWeight,
   pollWeightCacheKey,
   PollNotFoundError,
} from './key-poll-weight.service';

const mockGetPollVoteWeight = getPollVoteWeight as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/v1/keys', keysRouter);

const KEY_ID = 'key-1';
const POLL_ID = 'prop-1';
const WALLET = `G${'A'.repeat(55)}`;
const OTHER_WALLET = `G${'B'.repeat(55)}`;

beforeEach(() => {
   jest.clearAllMocks();
   mockCacheStore.clear();
   mockTtls.length = 0;
});

describe('GET /api/v1/keys/:keyId/polls/:pollId/weight/:wallet', () => {
   it('returns the vote weight and snapshot block from the service', async () => {
      mockGetPollVoteWeight.mockResolvedValue({
         vote_weight: '120',
         snapshot_block: 4821,
      });

      const res = await request(
         app
      ).get(`/api/v1/keys/${KEY_ID}/polls/${POLL_ID}/weight/${WALLET}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({
         vote_weight: '120',
         snapshot_block: 4821,
      });
      expect(mockGetPollVoteWeight).toHaveBeenCalledWith(
         KEY_ID,
         POLL_ID,
         WALLET
      );
   });

   it('zero weight is returned unchanged', async () => {
      mockGetPollVoteWeight.mockResolvedValue({
         vote_weight: '0',
         snapshot_block: 4821,
      });

      const res = await request(
         app
      ).get(`/api/v1/keys/${KEY_ID}/polls/${POLL_ID}/weight/${WALLET}`);

      expect(res.status).toBe(200);
      expect(res.body.data.vote_weight).toBe('0');
   });

   it('serves the second request for the same wallet/poll from cache', async () => {
      mockGetPollVoteWeight.mockResolvedValue({
         vote_weight: '120',
         snapshot_block: 4821,
      });

      const url = `/api/v1/keys/${KEY_ID}/polls/${POLL_ID}/weight/${WALLET}`;
      await request(app).get(url);
      const startedAt = Date.now();
      const res = await request(app).get(url);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
         vote_weight: '120',
         snapshot_block: 4821,
      });
      expect(mockGetPollVoteWeight).toHaveBeenCalledTimes(1);
      expect(mockTtls).toEqual([30]);
      expect(Date.now() - startedAt).toBeLessThan(200);
      expect(mockCacheStore.has(pollWeightCacheKey(KEY_ID, POLL_ID, WALLET))).toBe(
         true
      );
   });

   it('caches each wallet/poll pair separately', async () => {
      mockGetPollVoteWeight.mockResolvedValue({
         vote_weight: '120',
         snapshot_block: 4821,
      });

      await request(
         app
      ).get(`/api/v1/keys/${KEY_ID}/polls/${POLL_ID}/weight/${WALLET}`);
      await request(
         app
      ).get(
         `/api/v1/keys/${KEY_ID}/polls/${POLL_ID}/weight/${OTHER_WALLET}`
      );

      expect(mockGetPollVoteWeight).toHaveBeenCalledTimes(2);
   });

   it('returns 404 when the poll is unknown', async () => {
      mockGetPollVoteWeight.mockRejectedValue(new PollNotFoundError(POLL_ID));

      const res = await request(
         app
      ).get(`/api/v1/keys/${KEY_ID}/polls/prop-9/weight/${WALLET}`);

      expect(res.status).toBe(404);
      expect(mockCacheStore.size).toBe(0);
   });

   it('returns 400 for a malformed wallet address', async () => {
      const res = await request(
         app
      ).get(`/api/v1/keys/${KEY_ID}/polls/${POLL_ID}/weight/not-an-address`);

      expect(res.status).toBe(400);
      expect(mockGetPollVoteWeight).not.toHaveBeenCalled();
   });
});
