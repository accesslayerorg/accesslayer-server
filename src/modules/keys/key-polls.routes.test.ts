import express from 'express';
import request from 'supertest';
import keyPollsRouter from './key-polls.routes';
import { getKeyPoll, getKeyPollVote, getKeyPolls } from './key-polls.service';

jest.mock('./key-polls.service', () => ({
   KeyPollNotFoundError: class KeyPollNotFoundError extends Error {},
   getKeyPoll: jest.fn(),
   getKeyPollVote: jest.fn(),
   getKeyPolls: jest.fn(),
}));

const mockGetKeyPolls = getKeyPolls as jest.Mock;
const mockGetKeyPoll = getKeyPoll as jest.Mock;
const mockGetKeyPollVote = getKeyPollVote as jest.Mock;
const app = express();
app.use('/api/v1/keys', keyPollsRouter);

const wallet = `G${'A'.repeat(55)}`;

describe('community poll routes', () => {
   beforeEach(() => jest.clearAllMocks());

   it('returns the key poll list', async () => {
      mockGetKeyPolls.mockResolvedValue([
         { pollId: 'poll-1', status: 'active' },
      ]);
      const response = await request(app).get('/api/v1/keys/key-1/polls');

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([
         { pollId: 'poll-1', status: 'active' },
      ]);
      expect(mockGetKeyPolls).toHaveBeenCalledWith('key-1');
   });

   it('returns poll detail and per-option results', async () => {
      mockGetKeyPoll.mockResolvedValue({
         pollId: 'poll-1',
         optionResults: [
            { optionIndex: 0, option: 'Yes', votes: 2, weight: '8' },
         ],
      });
      const response = await request(app).get(
         '/api/v1/keys/key-1/polls/poll-1'
      );

      expect(response.status).toBe(200);
      expect(response.body.data.optionResults[0].weight).toBe('8');
   });

   it('returns the wallet vote and weight', async () => {
      mockGetKeyPollVote.mockResolvedValue({
         wallet,
         voted: true,
         vote: { optionIndex: 1, option: 'No', weight: '5' },
      });
      const response = await request(app).get(
         `/api/v1/keys/key-1/polls/poll-1/votes/${wallet}`
      );

      expect(response.status).toBe(200);
      expect(response.body.data.vote).toEqual({
         optionIndex: 1,
         option: 'No',
         weight: '5',
      });
      expect(mockGetKeyPollVote).toHaveBeenCalledWith(
         'key-1',
         'poll-1',
         wallet
      );
   });

   it('rejects malformed wallet addresses', async () => {
      const response = await request(app).get(
         '/api/v1/keys/key-1/polls/poll-1/votes/not-a-wallet'
      );

      expect(response.status).toBe(400);
      expect(mockGetKeyPollVote).not.toHaveBeenCalled();
   });
});
