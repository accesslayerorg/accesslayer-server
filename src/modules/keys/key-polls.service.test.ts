import {
   getKeyPollDetail,
   invalidateKeyPollsCache,
   listKeyPolls,
   PollNotFoundError,
} from './key-polls.service';
import { processPollEvents } from '../indexer/poll-indexer.service';
import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheInvalidate,
   cacheSetJson,
} from '../../utils/redis.utils';

const mockCache = new Map<string, string>();

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) => {
      const val = mockCache.get(key);
      return val === undefined ? null : JSON.parse(val);
   }),
   cacheSetJson: jest.fn(async (key: string, value: unknown) => {
      mockCache.set(key, JSON.stringify(value));
   }),
   cacheInvalidate: jest.fn(async (...patterns: string[]) => {
      for (const pattern of patterns) {
         const prefix = pattern.replace(/\*$/, '');
         for (const k of Array.from(mockCache.keys())) {
            if (k.startsWith(prefix)) mockCache.delete(k);
         }
      }
   }),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      governanceProposal: {
         findMany: jest.fn(),
         count: jest.fn(),
         findFirst: jest.fn(),
         update: jest.fn(),
      },
      governanceVote: {
         findUnique: jest.fn(),
         create: jest.fn(),
      },
      $transaction: jest.fn(async (ops: Array<Promise<unknown>>) =>
         Promise.all(ops)
      ),
   },
}));

const NOW = new Date('2026-10-21T12:00:00.000Z');
const FUTURE = new Date('2026-10-21T13:00:00.000Z');
const PAST = new Date('2026-10-21T10:00:00.000Z');
const WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

beforeEach(() => {
   jest.clearAllMocks();
   mockCache.clear();
});

describe('key-polls.service (#1174)', () => {
   it('lists active and closed polls with tally and time remaining', async () => {
      (prisma.governanceProposal.findMany as jest.Mock).mockResolvedValue([
         {
            keyId: 'key-1',
            proposalId: 'poll-1',
            title: 'Next Roadmap Item',
            options: ['Feature A', 'Feature B'],
            totalVotingWeight: '100',
            results: { 'Feature A': '75', 'Feature B': '25' },
            snapshotLedger: 500,
            expiresAt: FUTURE,
            closedAt: null,
            status: 'active',
         },
         {
            keyId: 'key-1',
            proposalId: 'poll-2',
            title: 'Past Poll',
            options: ['Yes', 'No'],
            totalVotingWeight: '50',
            results: { Yes: '50', No: '0' },
            snapshotLedger: 400,
            expiresAt: PAST,
            closedAt: PAST,
            status: 'passed',
         },
      ]);
      (prisma.governanceProposal.count as jest.Mock).mockResolvedValue(2);

      const page = await listKeyPolls('key-1', { page: 1, limit: 10, now: NOW });

      expect(page.polls).toHaveLength(2);
      expect(page.polls[0]).toMatchObject({
         poll_id: 'poll-1',
         status: 'active',
         time_remaining_seconds: 3600,
         tally: { 'Feature A': '75', 'Feature B': '25' },
      });
      expect(page.polls[1]).toMatchObject({
         poll_id: 'poll-2',
         status: 'closed',
         time_remaining_seconds: 0,
      });
      expect(cacheSetJson).toHaveBeenCalledWith(
         'key:polls:key-1:list:all:1:10',
         expect.any(Object),
         30
      );
   });

   it('returns single poll detail with per-option results and wallet vote', async () => {
      (prisma.governanceProposal.findFirst as jest.Mock).mockResolvedValue({
         keyId: 'key-1',
         proposalId: 'poll-1',
         title: 'Next Roadmap Item',
         options: ['Feature A', 'Feature B'],
         totalVotingWeight: '100',
         results: { 'Feature A': '75', 'Feature B': '25' },
         snapshotLedger: 500,
         expiresAt: FUTURE,
         closedAt: null,
         status: 'active',
      });
      (prisma.governanceVote.findUnique as jest.Mock).mockResolvedValue({
         voter: WALLET,
         optionIndex: 0,
         weight: '75',
      });

      const detail = await getKeyPollDetail('key-1', 'poll-1', WALLET, NOW);

      expect(detail.option_results).toEqual([
         { index: 0, option: 'Feature A', votes: '75', percentage: 75 },
         { index: 1, option: 'Feature B', votes: '25', percentage: 25 },
      ]);
      expect(detail.wallet_vote).toEqual({
         voter: WALLET,
         option_index: 0,
         option: 'Feature A',
         weight: '75',
      });
      expect(cacheGetJson).toHaveBeenCalled();
   });

   it('throws PollNotFoundError (404) for unknown poll IDs', async () => {
      (prisma.governanceProposal.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
         getKeyPollDetail('key-1', 'unknown-poll')
      ).rejects.toBeInstanceOf(PollNotFoundError);
   });

   it('invalidates poll cache on PollVoteCast and PollClosed events', async () => {
      (prisma.governanceProposal.findFirst as jest.Mock).mockResolvedValue({
         id: 'row-1',
         keyId: 'key-1',
         proposalId: 'poll-1',
         options: ['Yes', 'No'],
         totalVotingWeight: '10',
         results: { Yes: '10', No: '0' },
         status: 'active',
      });
      (prisma.governanceVote.findUnique as jest.Mock).mockResolvedValue(null);

      await processPollEvents([
         {
            eventType: 'PollVoteCast',
            key_id: 'key-1',
            poll_id: 'poll-1',
            voter: WALLET,
            option_index: 1,
            weight: '5',
            txHash: 'tx-poll-vote',
            eventIndex: 0,
            ledger: 600,
         },
         {
            eventType: 'PollClosed',
            key_id: 'key-1',
            poll_id: 'poll-1',
            txHash: 'tx-poll-close',
            eventIndex: 1,
            ledger: 601,
         },
      ]);

      expect(cacheInvalidate).toHaveBeenCalledWith(
         'key:polls:key-1:*',
         'key:poll:weight:key-1:*'
      );

      await invalidateKeyPollsCache('key-1');
      expect(cacheInvalidate).toHaveBeenCalledTimes(3);
   });
});
