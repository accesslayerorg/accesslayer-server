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
      const page = await getKeyPolls('key-1');

      expect(page.nextCursor).toBeNull();
      expect(page.items[0]).toMatchObject({
         pollId: 'poll-1',
         totalVotes: 2,
         totalVotingWeight: '7.5',
         results: { A: '7.5', B: '0' },
         status: 'active',
      });
      expect(page.items[0].timeRemainingSeconds).toBeGreaterThan(0);
      expect(cacheSetJson).toHaveBeenCalledWith(
         'key:polls:key-1:list:all:first:20',
         page,
         KEY_POLLS_CACHE_SECONDS
      );
      expect(KEY_POLLS_CACHE_SECONDS).toBe(30);
   });

   it('returns a next cursor when another page exists', async () => {
      const second = { ...poll, pollId: 'poll-2' };
      const third = { ...poll, pollId: 'poll-3' };
      mockPrisma.keyPoll.findMany.mockResolvedValue([poll, second, third]);

      const page = await getKeyPolls('key-1', { limit: 2 });

      expect(page.items.map(item => item.pollId)).toEqual(['poll-1', 'poll-2']);
      expect(page.nextCursor).toBe('poll-2');
      expect(mockPrisma.keyPoll.findMany).toHaveBeenCalledWith(
         expect.objectContaining({ take: 3 })
      );
   });

   it('applies the closed filter and reports zero time remaining', async () => {
      const closedPoll = {
         ...poll,
         pollId: 'poll-old',
         status: 'closed',
         closedAt: new Date('2026-06-01T00:00:00.000Z'),
      };
      mockPrisma.keyPoll.findMany.mockResolvedValue([closedPoll]);

      const page = await getKeyPolls('key-1', { status: 'closed' });

      expect(mockPrisma.keyPoll.findMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: expect.objectContaining({
               keyId: 'key-1',
               OR: expect.any(Array),
            }),
         })
      );
      expect(page.items[0]).toMatchObject({
         status: 'closed',
         timeRemainingSeconds: 0,
      });
   });

   it('rejects a cursor that does not name a poll under the key', async () => {
      mockPrisma.keyPoll.findUnique.mockResolvedValueOnce(null);

      await expect(
         getKeyPolls('key-1', { cursor: 'missing-poll' })
      ).rejects.toThrow('Invalid poll cursor: missing-poll');
   });

   it('attaches the wallet vote to poll detail when a wallet is given', async () => {
      const detail = await getKeyPoll('key-1', 'poll-1', 'G123');

      expect(detail.walletVote).toEqual({
         wallet: 'G123',
         voted: true,
         vote: { optionIndex: 1, option: 'B', weight: '3.25' },
      });
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
