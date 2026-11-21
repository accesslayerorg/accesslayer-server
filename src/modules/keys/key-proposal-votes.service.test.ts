// src/modules/keys/key-proposal-votes.service.test.ts
jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      governanceProposal: {
         findFirst: jest.fn(),
         findUnique: jest.fn(),
         update: jest.fn(),
      },
      governanceVote: {
         findUnique: jest.fn(),
         create: jest.fn(),
      },
      activity: { create: jest.fn() },
      keyOwnership: { findUnique: jest.fn(), aggregate: jest.fn() },
      voteDelegation: { findMany: jest.fn(), count: jest.fn() },
      $transaction: jest.fn(),
   },
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

import { prisma } from '../../utils/prisma.utils';
import {
   applyVoteWeight,
   castKeyProposalVote,
   DuplicateVoteError,
   HolderNotEligibleError,
   OptionIndexOutOfRangeError,
   ProposalTotals,
} from './key-proposal-votes.service';

interface MockPrismaClient {
   governanceProposal: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
   };
   governanceVote: { findUnique: jest.Mock; create: jest.Mock };
   activity: { create: jest.Mock };
   keyOwnership: { findUnique: jest.Mock; aggregate: jest.Mock };
   voteDelegation: { findMany: jest.Mock; count: jest.Mock };
   $transaction: jest.Mock;
}

const mockPrisma = prisma as unknown as MockPrismaClient;

const KEY_ID = 'key-1';
const PROPOSAL_ID = 'prop-1';
const OPTIONS = ['Yes', 'No'];

interface ProposalStore {
   total: string;
   results: Record<string, string>;
   status: string;
}

function makeStore(): ProposalStore {
   return { total: '0', results: {}, status: 'active' };
}

/**
 * Wires the governanceProposal mocks around a mutable store so the
 * in-transaction read (findUnique) and the tally update (update) stay
 * consistent across multiple votes in the same test.
 */
function wireProposalMocks(store: ProposalStore, options = OPTIONS) {
   mockPrisma.governanceProposal.findFirst.mockImplementation(async () => ({
      status: store.status,
      options,
   }));

   mockPrisma.governanceProposal.findUnique.mockImplementation(async () => ({
      totalVotingWeight: store.total,
      results: store.results,
      status: store.status,
   }));

   mockPrisma.governanceProposal.update.mockImplementation(async (args: any) => {
      store.total = args.data.totalVotingWeight;
      store.results = args.data.results;
      return { totalVotingWeight: store.total, results: store.results };
   });
}

function wireSupportingMocks(
   opts: { voted?: boolean; balance?: number } = {}
) {
   const { voted = false, balance = 5 } = opts;
   mockPrisma.governanceVote.findUnique.mockResolvedValue(
      voted ? { id: 'existing-vote' } : null
   );
   mockPrisma.governanceVote.create.mockResolvedValue({ id: 'vote-1' });
   mockPrisma.keyOwnership.findUnique.mockResolvedValue({
      balance: balance ?? 0,
   });
   mockPrisma.keyOwnership.aggregate.mockResolvedValue({ _sum: { balance: 0 } });
   mockPrisma.voteDelegation.findMany.mockResolvedValue([]);
   mockPrisma.voteDelegation.count.mockResolvedValue(0);
   mockPrisma.activity.create.mockResolvedValue({});
   mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(mockPrisma));
}

beforeEach(() => {
   jest.clearAllMocks();
   mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(mockPrisma));
});

describe('applyVoteWeight', () => {
   it('adds a single vote to an empty proposal', () => {
      const out = applyVoteWeight(
         { totalVotingWeight: '0', results: {} },
         '5',
         'Yes'
      );
      expect(out.totalVotingWeight).toBe('5');
      expect(out.results).toEqual({ Yes: '5' });
   });

   it('accumulates the same option across repeated calls', () => {
      let cur: ProposalTotals = { totalVotingWeight: '0', results: {} };
      cur = applyVoteWeight(cur, '5', 'Yes');
      cur = applyVoteWeight(cur, '3', 'Yes');
      expect(cur.totalVotingWeight).toBe('8');
      expect(cur.results.Yes).toBe('8');
   });

   it('tracks different options separately while accumulating the total', () => {
      let cur: ProposalTotals = { totalVotingWeight: '0', results: {} };
      cur = applyVoteWeight(cur, '5', 'Yes');
      cur = applyVoteWeight(cur, '3', 'No');
      expect(cur.totalVotingWeight).toBe('8');
      expect(cur.results).toEqual({ Yes: '5', No: '3' });
   });

   it('preserves untouched option buckets', () => {
      const out = applyVoteWeight(
         { totalVotingWeight: '10', results: { Yes: '6', No: '4' } },
         '2',
         'No'
      );
      expect(out.results).toEqual({ Yes: '6', No: '6' });
      expect(out.totalVotingWeight).toBe('12');
   });

   it('handles very large totals without floating-point drift', () => {
      const out = applyVoteWeight(
         {
            totalVotingWeight: '9999999999999999998',
            results: { Yes: '9999999999999999998' },
         },
         '1',
         'Yes'
      );
      expect(out.totalVotingWeight).toBe('9999999999999999999');
      expect(out.results.Yes).toBe('9999999999999999999');
   });

   it('treats empty / undefined tally values as zero', () => {
      const empty = applyVoteWeight(
         { totalVotingWeight: '', results: {} },
         '7',
         'Yes'
      );
      expect(empty.totalVotingWeight).toBe('7');
      expect(empty.results.Yes).toBe('7');

      const undefinedResults = applyVoteWeight(
         { totalVotingWeight: '0', results: undefined as unknown as Record<string, string> },
         '4',
         'Yes'
      );
      expect(undefinedResults.totalVotingWeight).toBe('4');
      expect(undefinedResults.results.Yes).toBe('4');
   });
});

describe('castKeyProposalVote tallying', () => {
   it('updates totalVotingWeight and results for a single vote', async () => {
      const store = makeStore();
      wireProposalMocks(store);
      wireSupportingMocks({ voted: false, balance: 5 });

      const res = await castKeyProposalVote(KEY_ID, PROPOSAL_ID, 0, 'walletA');

      expect(res.weight).toBe('5');
      expect(res.option).toBe('Yes');

      const updateCall = mockPrisma.governanceProposal.update.mock.calls[0];
      expect(updateCall[0].data.totalVotingWeight).toBe('5');
      expect(updateCall[0].data.results).toEqual({ Yes: '5' });

      expect(mockPrisma.governanceVote.create).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({
               voter: 'walletA',
               optionIndex: 0,
               keyId: KEY_ID,
               proposalId: PROPOSAL_ID,
            }),
         })
      );
      expect(mockPrisma.activity.create).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({
               type: 'GOVERNANCE_VOTE_CAST',
               actor: 'walletA',
               payload: expect.objectContaining({ totalWeight: '5' }),
            }),
         })
      );
   });

   it('includes active delegators in the persisted vote weight', async () => {
      const store = makeStore();
      wireProposalMocks(store);
      wireSupportingMocks({ voted: false, balance: 5 });
      mockPrisma.voteDelegation.findMany.mockResolvedValue([
         { delegatorWallet: 'walletB' },
         { delegatorWallet: 'walletC' },
      ]);
      mockPrisma.voteDelegation.count.mockResolvedValue(2);
      mockPrisma.keyOwnership.aggregate.mockResolvedValue({
         _sum: { balance: 7 },
      });

      const result = await castKeyProposalVote(KEY_ID, PROPOSAL_ID, 0, 'walletA');

      expect(result).toMatchObject({
         weight: '12',
         ownWeight: '5',
         delegatedWeight: '7',
         delegatorCount: 2,
      });
      expect(store.total).toBe('12');
      expect(store.results).toEqual({ Yes: '12' });
   });

   it('accumulates tallies across multiple votes cast by different wallets on different options', async () => {
      const store = makeStore();
      wireProposalMocks(store);
      wireSupportingMocks({ voted: false, balance: 5 });

      // walletA: 5 keys -> "Yes"
      await castKeyProposalVote(KEY_ID, PROPOSAL_ID, 0, 'walletA');
      expect(store.total).toBe('5');
      expect(store.results).toEqual({ Yes: '5' });

      // walletB holds 3 keys -> "No"
      mockPrisma.keyOwnership.findUnique.mockResolvedValue({ balance: 3 });

      await castKeyProposalVote(KEY_ID, PROPOSAL_ID, 1, 'walletB');
      expect(store.total).toBe('8');
      expect(store.results).toEqual({ Yes: '5', No: '3' });

      // walletC holds 2 keys -> "Yes" again
      mockPrisma.keyOwnership.findUnique.mockResolvedValue({ balance: 2 });

      await castKeyProposalVote(KEY_ID, PROPOSAL_ID, 0, 'walletC');
      expect(store.total).toBe('10');
      expect(store.results).toEqual({ Yes: '7', No: '3' });
   });

   it('records a single vote in proposal_votes within the same transaction as the tally update', async () => {
      const store = makeStore();
      wireProposalMocks(store);
      wireSupportingMocks({ voted: false, balance: 5 });

      await castKeyProposalVote(KEY_ID, PROPOSAL_ID, 0, 'walletA');

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.governanceVote.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.governanceProposal.update).toHaveBeenCalledTimes(1);
   });

   it('throws DuplicateVoteError when the wallet has already voted', async () => {
      const store = makeStore();
      wireProposalMocks(store);
      wireSupportingMocks({ voted: true, balance: 5 });

      await expect(
         castKeyProposalVote(KEY_ID, PROPOSAL_ID, 0, 'walletA')
      ).rejects.toBeInstanceOf(DuplicateVoteError);

      expect(mockPrisma.governanceProposal.update).not.toHaveBeenCalled();
      expect(mockPrisma.governanceVote.create).not.toHaveBeenCalled();
   });

   it('throws HolderNotEligibleError when the wallet holds no keys', async () => {
      const store = makeStore();
      wireProposalMocks(store);
      wireSupportingMocks({ voted: false, balance: 0 });

      await expect(
         castKeyProposalVote(KEY_ID, PROPOSAL_ID, 0, 'walletA')
      ).rejects.toBeInstanceOf(HolderNotEligibleError);

      expect(mockPrisma.governanceProposal.update).not.toHaveBeenCalled();
   });

   it('throws OptionIndexOutOfRangeError for an out-of-range option', async () => {
      const store = makeStore();
      wireProposalMocks(store);
      wireSupportingMocks({ voted: false, balance: 5 });

      await expect(
         castKeyProposalVote(KEY_ID, PROPOSAL_ID, 99, 'walletA')
      ).rejects.toBeInstanceOf(OptionIndexOutOfRangeError);
   });

   it('throws ProposalNotFoundOrClosedError when the proposal is closed at commit time', async () => {
      const store = makeStore();
      store.status = 'closed';
      wireProposalMocks(store);
      wireSupportingMocks({ voted: false, balance: 5 });

      await expect(
         castKeyProposalVote(KEY_ID, PROPOSAL_ID, 0, 'walletA')
      ).rejects.toThrow('Proposal not found or closed');

      expect(mockPrisma.governanceVote.create).not.toHaveBeenCalled();
   });
});
