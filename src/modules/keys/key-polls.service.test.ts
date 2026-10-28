import {
   getKeyPoll,
   getKeyPollVote,
   getKeyPolls,
   KEY_POLLS_CACHE_SECONDS,
} from './key-polls.service';
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findUnique: jest.fn() },
      keyPoll: { findMany: jest.fn(), findUnique: jest.fn() },
      keyPollVote: { findUnique: jest.fn(), groupBy: jest.fn() },
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(),
   cacheSetJson: jest.fn(),
}));

const mockPrisma = prisma as unknown as {
   creatorProfile: { findUnique: jest.Mock };
   keyPoll: { findMany: jest.Mock; findUnique: jest.Mock };
   keyPollVote: { findUnique: jest.Mock; groupBy: jest.Mock };
};

const poll = {
   keyId: 'key-1',
   pollId: 'poll-1',
   question: 'Choose',
   options: ['A', 'B'],
   status: 'active',
   expiresAt: new Date('2027-01-01T00:00:00.000Z'),
   closedAt: null,
};

describe('community poll read service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      (cacheGetJson as jest.Mock).mockResolvedValue(null);
      mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'key-1' });
      mockPrisma.keyPoll.findMany.mockResolvedValue([poll]);
      mockPrisma.keyPoll.findUnique.mockResolvedValue(poll);
      mockPrisma.keyPollVote.groupBy.mockResolvedValue([
         {
            optionIndex: 0,
            _count: { _all: 2 },
            _sum: { weight: { toString: () => '7.5' } },
         },
      ]);
      mockPrisma.keyPollVote.findUnique.mockResolvedValue({
         optionIndex: 1,
         weight: { toString: () => '3.25' },
      });
   });

   it('returns accurate totals and caches poll lists for 30 seconds', async () => {
      const result = await getKeyPolls('key-1');

      expect(result[0]).toMatchObject({
         pollId: 'poll-1',
         totalVotes: 2,
         totalVotingWeight: '7.5',
         results: { A: '7.5', B: '0' },
         status: 'active',
      });
      expect(cacheSetJson).toHaveBeenCalledWith(
         'key:polls:key-1:list',
         result,
         KEY_POLLS_CACHE_SECONDS
      );
      expect(KEY_POLLS_CACHE_SECONDS).toBe(30);
   });

   it('returns per-option results for poll details', async () => {
      const result = await getKeyPoll('key-1', 'poll-1');

      expect(result.optionResults).toEqual([
         { optionIndex: 0, option: 'A', votes: 2, weight: '7.5' },
         { optionIndex: 1, option: 'B', votes: 0, weight: '0' },
      ]);
   });

   it('returns the selected option and indexed vote weight for a wallet', async () => {
      const result = await getKeyPollVote('key-1', 'poll-1', 'G123');

      expect(result).toEqual({
         wallet: 'G123',
         voted: true,
         vote: { optionIndex: 1, option: 'B', weight: '3.25' },
      });
   });
});
