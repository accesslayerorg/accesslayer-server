// src/modules/governance/governance-proposals.service.test.ts
jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      governanceProposal: {
         findFirst: jest.fn(),
         findUnique: jest.fn(),
         findMany: jest.fn(),
         create: jest.fn(),
         update: jest.fn(),
      },
      governanceVotingSnapshot: {
         findUnique: jest.fn(),
         createMany: jest.fn(),
         deleteMany: jest.fn(),
      },
      governanceVote: { findUnique: jest.fn(), create: jest.fn() },
      activity: { create: jest.fn() },
      creatorProfile: { findFirst: jest.fn() },
      stellarWallet: { findUnique: jest.fn() },
      stakingPosition: { groupBy: jest.fn() },
      indexedLedger: { findFirst: jest.fn() },
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
   castGovernanceVote,
   closeDueProposals,
   computeStakedBalancesForKey,
   createGovernanceProposal,
   DuplicateGovernanceVoteError,
   evaluateProposalOutcome,
   getProposalVotingWeight,
   GovernanceKeyNotFoundError,
   GovernanceProposalNotFoundError,
   InvalidVoteOptionError,
   listGovernanceProposals,
   NoSnapshotVotingPowerError,
   NotKeyCreatorError,
   pruneProposalSnapshots,
   recordProposalSnapshot,
   validateVoteSubmissionWeight,
   VotingPeriodEndedError,
   WalletNotRegisteredError,
} from './governance-proposals.service';


const mockPrisma = prisma as any;

const KEY_ID = 'key-1';
const PROPOSAL_ID = 'prop-key-1-123';
const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
const PAST = new Date(Date.now() - 60 * 60 * 1000);

function makeActiveProposal(overrides: Record<string, any> = {}) {
   return {
      id: 'gov-db-1',
      keyId: KEY_ID,
      proposalId: PROPOSAL_ID,
      title: 'Should we fund the treasury?',
      options: ['Yes', 'No'],
      totalVotingWeight: '0',
      results: { Yes: '0', No: '0' },
      snapshotLedger: 4242,
      snapshotTotalWeight: '100',
      quorumBps: 3000,
      expiresAt: FUTURE,
      closedAt: null,
      status: 'active',
      createdAt: new Date('2026-10-16T00:00:00.000Z'),
      ...overrides,
   };
}

beforeEach(() => {
   jest.clearAllMocks();
   mockPrisma.$transaction.mockImplementation(async (cb: any) =>
      cb(mockPrisma)
   );
   mockPrisma.activity.create.mockResolvedValue({});
});

describe('computeStakedBalancesForKey (#878)', () => {
   it('sums per-wallet staked amounts and truncates fractional key counts', async () => {
      mockPrisma.stakingPosition.groupBy.mockResolvedValue([
         { wallet: 'walletA', _sum: { amount: '10' } },
         { wallet: 'walletB', _sum: { amount: '5.9' } },
         { wallet: 'walletC', _sum: { amount: '0' } },
      ]);

      const balances = await computeStakedBalancesForKey(KEY_ID, new Date());

      expect(balances).toEqual([
         { wallet: 'walletA', weight: '10' },
         { wallet: 'walletB', weight: '5' },
      ]);
   });
});

describe('createGovernanceProposal (#878)', () => {
   function wireCreateDeps() {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue({
         id: KEY_ID,
         userId: 'user-1',
      });
      mockPrisma.stellarWallet.findUnique.mockResolvedValue({
         userId: 'user-1',
      });
      mockPrisma.indexedLedger.findFirst.mockResolvedValue({ ledger: 4242 });
      mockPrisma.stakingPosition.groupBy.mockResolvedValue([
         { wallet: 'walletA', _sum: { amount: '10' } },
         { wallet: 'walletB', _sum: { amount: '5' } },
      ]);
      mockPrisma.governanceProposal.create.mockImplementation(
         async ({ data }: any) => ({
            id: 'gov-db-1',
            createdAt: new Date('2026-10-16T00:00:00.000Z'),
            ...data,
         })
      );
      mockPrisma.governanceVotingSnapshot.createMany.mockResolvedValue({
         count: 2,
      });
   }

   it('freezes per-wallet snapshot weights and records the snapshot block', async () => {
      wireCreateDeps();

      const result = await createGovernanceProposal(
         {
            keyId: KEY_ID,
            title: 'Treasury',
            options: ['Yes', 'No'],
            durationDays: 7,
         },
         'GPROPOSER'
      );

      expect(result.status).toBe('active');
      expect(result.snapshotLedger).toBe(4242);
      expect(result.snapshotTotalWeight).toBe('15');
      expect(result.quorumBps).toBe(3000);
      expect(result.totalVotingWeight).toBe('0');
      expect(result.results).toEqual({ Yes: '0', No: '0' });

      const createData =
         mockPrisma.governanceProposal.create.mock.calls[0][0].data;
      expect(createData).toMatchObject({
         keyId: KEY_ID,
         snapshotLedger: 4242,
         snapshotTotalWeight: '15',
         quorumBps: 3000,
         status: 'active',
      });
   });

   it('persists one snapshot row per eligible wallet', async () => {
      wireCreateDeps();

      await createGovernanceProposal(
         {
            keyId: KEY_ID,
            title: 'Treasury',
            options: ['Yes', 'No'],
            durationDays: 3,
         },
         'GPROPOSER'
      );

      const rows =
         mockPrisma.governanceVotingSnapshot.createMany.mock.calls[0][0].data;
      expect(
         rows.map((r: any) => ({
            wallet: r.wallet,
            weight: r.weight.toString(),
         }))
      ).toEqual([
         { wallet: 'walletA', weight: '10' },
         { wallet: 'walletB', weight: '5' },
      ]);
   });

   it('honours an explicit quorumBps override', async () => {
      wireCreateDeps();

      const result = await createGovernanceProposal(
         {
            keyId: KEY_ID,
            title: 'Treasury',
            options: ['Yes', 'No'],
            durationDays: 3,
            quorumBps: 5000,
         },
         'GPROPOSER'
      );

      expect(result.quorumBps).toBe(5000);
   });

   it('rejects a proposal for an unknown key', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue(null);

      await expect(
         createGovernanceProposal(
            {
               keyId: 'missing',
               title: 'X',
               options: ['Yes', 'No'],
               durationDays: 3,
            },
            'GWALLET'
         )
      ).rejects.toBeInstanceOf(GovernanceKeyNotFoundError);
   });

   it('rejects a proposer whose wallet is not registered', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue({
         id: KEY_ID,
         userId: 'user-1',
      });
      mockPrisma.stellarWallet.findUnique.mockResolvedValue(null);

      await expect(
         createGovernanceProposal(
            {
               keyId: KEY_ID,
               title: 'X',
               options: ['Yes', 'No'],
               durationDays: 3,
            },
            'GUNKNOWN'
         )
      ).rejects.toBeInstanceOf(WalletNotRegisteredError);
   });

   it('rejects a proposer who does not own the key', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue({
         id: KEY_ID,
         userId: 'user-1',
      });
      mockPrisma.stellarWallet.findUnique.mockResolvedValue({
         userId: 'user-2',
      });

      await expect(
         createGovernanceProposal(
            {
               keyId: KEY_ID,
               title: 'X',
               options: ['Yes', 'No'],
               durationDays: 3,
            },
            'GOTHER'
         )
      ).rejects.toBeInstanceOf(NotKeyCreatorError);
   });
});

describe('castGovernanceVote (#878)', () => {
   function wireVoteDeps(
      opts: { weight?: string | null; voted?: boolean; proposal?: any } = {}
   ) {
      const { weight = '10', voted = false } = opts;
      const proposal = opts.proposal ?? makeActiveProposal();
      mockPrisma.governanceProposal.findFirst.mockResolvedValue(proposal);
      mockPrisma.governanceProposal.findUnique.mockResolvedValue({
         status: proposal.status,
         expiresAt: proposal.expiresAt,
         totalVotingWeight: proposal.totalVotingWeight,
         results: proposal.results,
      });
      mockPrisma.governanceVotingSnapshot.findUnique.mockResolvedValue(
         weight === null ? null : { weight }
      );
      mockPrisma.governanceVote.findUnique.mockResolvedValue(
         voted ? { id: 'existing' } : null
      );
      mockPrisma.governanceVote.create.mockResolvedValue({ id: 'vote-1' });
      mockPrisma.governanceProposal.update.mockResolvedValue({});
   }

   it('weights the vote from the snapshot, not live holdings', async () => {
      wireVoteDeps({ weight: '7' });

      const result = await castGovernanceVote(PROPOSAL_ID, 'walletA', 0);

      expect(result.weight).toBe('7');
      expect(result.option).toBe('Yes');
      expect(result.totalVotingWeight).toBe('7');
      expect(result.results).toEqual({ Yes: '7', No: '0' });

      expect(mockPrisma.governanceVote.create).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({
               keyId: KEY_ID,
               proposalId: PROPOSAL_ID,
               voter: 'walletA',
               optionIndex: 0,
            }),
         })
      );
   });

   it('rejects a vote after the proposal deadline', async () => {
      wireVoteDeps({
         weight: '10',
         proposal: makeActiveProposal({ expiresAt: PAST }),
      });

      await expect(
         castGovernanceVote(PROPOSAL_ID, 'walletA', 0)
      ).rejects.toBeInstanceOf(VotingPeriodEndedError);

      expect(mockPrisma.governanceVote.create).not.toHaveBeenCalled();
   });

   it('rejects a vote on a closed proposal', async () => {
      wireVoteDeps({
         weight: '10',
         proposal: makeActiveProposal({ status: 'passed' }),
      });

      await expect(
         castGovernanceVote(PROPOSAL_ID, 'walletA', 0)
      ).rejects.toBeInstanceOf(VotingPeriodEndedError);
   });

   it('rejects a duplicate vote from the same wallet', async () => {
      wireVoteDeps({ weight: '10', voted: true });

      await expect(
         castGovernanceVote(PROPOSAL_ID, 'walletA', 0)
      ).rejects.toBeInstanceOf(DuplicateGovernanceVoteError);

      expect(mockPrisma.governanceProposal.update).not.toHaveBeenCalled();
   });

   it('rejects a wallet with no snapshot voting power', async () => {
      wireVoteDeps({ weight: null });

      await expect(
         castGovernanceVote(PROPOSAL_ID, 'walletZ', 0)
      ).rejects.toBeInstanceOf(NoSnapshotVotingPowerError);
   });

   it('rejects an out-of-range option index', async () => {
      wireVoteDeps({ weight: '10' });

      await expect(
         castGovernanceVote(PROPOSAL_ID, 'walletA', 9)
      ).rejects.toBeInstanceOf(InvalidVoteOptionError);
   });

   it('rejects a vote for a missing proposal', async () => {
      mockPrisma.governanceProposal.findFirst.mockResolvedValue(null);

      await expect(
         castGovernanceVote('nope', 'walletA', 0)
      ).rejects.toBeInstanceOf(GovernanceProposalNotFoundError);
   });

   it('maps a concurrent duplicate insert to a duplicate-vote error', async () => {
      wireVoteDeps({ weight: '10' });
      mockPrisma.$transaction.mockRejectedValue(
         Object.assign(new Error('unique'), { code: 'P2002' })
      );

      await expect(
         castGovernanceVote(PROPOSAL_ID, 'walletA', 0)
      ).rejects.toBeInstanceOf(DuplicateGovernanceVoteError);
   });
});

describe('evaluateProposalOutcome (#878)', () => {
   it('is quorum_not_met when cast weight is below the quorum threshold', () => {
      expect(
         evaluateProposalOutcome({
            options: ['Yes', 'No'],
            results: { Yes: '20', No: '0' },
            castWeight: '20',
            snapshotTotalWeight: '100',
            quorumBps: 3000,
         })
      ).toBe('quorum_not_met');
   });

   it('is passed when quorum is met and an option has a strict majority', () => {
      expect(
         evaluateProposalOutcome({
            options: ['Yes', 'No'],
            results: { Yes: '60', No: '10' },
            castWeight: '70',
            snapshotTotalWeight: '100',
            quorumBps: 3000,
         })
      ).toBe('passed');
   });

   it('is failed when quorum is met but no option has a majority', () => {
      expect(
         evaluateProposalOutcome({
            options: ['Yes', 'No'],
            results: { Yes: '40', No: '40' },
            castWeight: '80',
            snapshotTotalWeight: '100',
            quorumBps: 3000,
         })
      ).toBe('failed');
   });

   it('is quorum_not_met when nothing was cast or no weight is eligible', () => {
      expect(
         evaluateProposalOutcome({
            options: ['Yes', 'No'],
            results: { Yes: '0', No: '0' },
            castWeight: '0',
            snapshotTotalWeight: '100',
            quorumBps: 3000,
         })
      ).toBe('quorum_not_met');

      expect(
         evaluateProposalOutcome({
            options: ['Yes', 'No'],
            results: { Yes: '5', No: '0' },
            castWeight: '5',
            snapshotTotalWeight: '0',
            quorumBps: 3000,
         })
      ).toBe('quorum_not_met');
   });

   it('treats a zero quorum as satisfied', () => {
      expect(
         evaluateProposalOutcome({
            options: ['A', 'B'],
            results: { A: '3', B: '2' },
            castWeight: '5',
            snapshotTotalWeight: '100',
            quorumBps: 0,
         })
      ).toBe('passed');
   });
});

describe('closeDueProposals (#878)', () => {
   it('transitions expired proposals to passed / failed / quorum_not_met', async () => {
      mockPrisma.governanceProposal.findMany.mockResolvedValue([
         makeActiveProposal({
            id: 'p-pass',
            totalVotingWeight: '60',
            results: { Yes: '60', No: '0' },
         }),
         makeActiveProposal({
            id: 'p-quorum',
            totalVotingWeight: '20',
            results: { Yes: '20', No: '0' },
         }),
         makeActiveProposal({
            id: 'p-fail',
            totalVotingWeight: '40',
            results: { Yes: '20', No: '20' },
         }),
      ]);
      mockPrisma.governanceProposal.update.mockResolvedValue({});

      const result = await closeDueProposals(new Date());

      expect(result).toMatchObject({
         scanned: 3,
         closed: 3,
         outcomes: { passed: 1, failed: 1, quorum_not_met: 1 },
      });

      const statuses = Object.fromEntries(
         mockPrisma.governanceProposal.update.mock.calls.map((call: any) => [
            call[0].where.id,
            call[0].data.status,
         ])
      );
      expect(statuses).toEqual({
         'p-pass': 'passed',
         'p-quorum': 'quorum_not_met',
         'p-fail': 'failed',
      });
   });

   it('does nothing when no proposal is due', async () => {
      mockPrisma.governanceProposal.findMany.mockResolvedValue([]);

      const result = await closeDueProposals(new Date());

      expect(result.closed).toBe(0);
      expect(mockPrisma.governanceProposal.update).not.toHaveBeenCalled();
   });
});

describe('listGovernanceProposals (#878)', () => {
   it('returns proposals with tallies, quorum, and status', async () => {
      mockPrisma.governanceProposal.findMany
         .mockResolvedValueOnce([]) // closeDueProposals: nothing due
         .mockResolvedValueOnce([
            makeActiveProposal({
               status: 'passed',
               totalVotingWeight: '60',
               results: { Yes: '60', No: '0' },
               closedAt: new Date('2026-10-16T01:00:00.000Z'),
            }),
         ]);

      const result = await listGovernanceProposals({});

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
         proposalId: PROPOSAL_ID,
         status: 'passed',
         snapshotTotalWeight: '100',
         quorumBps: 3000,
         quorumRequired: '30',
         quorumMet: true,
         winningOption: 'Yes',
         participationRate: 0.6,
      });
      expect(result.has_more).toBe(false);
      expect(result.next_cursor).toBeNull();
   });
});

describe('getProposalVotingWeight (#1036)', () => {
   it('returns frozen snapshot voting weight for a wallet and is unaffected by live balance changes', async () => {
      mockPrisma.governanceProposal.findFirst.mockResolvedValue(
         makeActiveProposal({ snapshotLedger: 4242, snapshotTotalWeight: '100' })
      );
      mockPrisma.governanceVotingSnapshot.findUnique.mockResolvedValue({
         weight: '25',
      });
      mockPrisma.governanceVote.findUnique.mockResolvedValue(null);

      // Even if live staking positions changed, getProposalVotingWeight only reads the snapshot
      mockPrisma.stakingPosition.groupBy.mockResolvedValue([
         { wallet: 'walletA', _sum: { amount: '999' } },
      ]);

      const result = await getProposalVotingWeight(PROPOSAL_ID, 'walletA');

      expect(result).toEqual({
         keyId: KEY_ID,
         proposalId: PROPOSAL_ID,
         wallet: 'walletA',
         weight: '25',
         snapshotLedger: 4242,
         snapshotTotalWeight: '100',
         eligible: true,
         hasVoted: false,
         proposalStatus: 'active',
      });
      expect(mockPrisma.stakingPosition.groupBy).not.toHaveBeenCalled();
   });

   it('returns weight 0 and eligible=false when wallet has no snapshot row', async () => {
      mockPrisma.governanceProposal.findFirst.mockResolvedValue(
         makeActiveProposal()
      );
      mockPrisma.governanceVotingSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.governanceVote.findUnique.mockResolvedValue(null);

      const result = await getProposalVotingWeight(PROPOSAL_ID, 'walletNone');

      expect(result.weight).toBe('0');
      expect(result.eligible).toBe(false);
      expect(result.hasVoted).toBe(false);
   });

   it('throws GovernanceProposalNotFoundError when proposal does not exist', async () => {
      mockPrisma.governanceProposal.findFirst.mockResolvedValue(null);

      await expect(
         getProposalVotingWeight('missing', 'walletA')
      ).rejects.toBeInstanceOf(GovernanceProposalNotFoundError);
   });
});

describe('validateVoteSubmissionWeight & pruneProposalSnapshots & recordProposalSnapshot (#1036)', () => {
   it('pre-validates vote submission using snapshot weight', async () => {
      mockPrisma.governanceProposal.findFirst.mockResolvedValue(
         makeActiveProposal()
      );
      mockPrisma.governanceVotingSnapshot.findUnique.mockResolvedValue({
         weight: '15',
      });
      mockPrisma.governanceVote.findUnique.mockResolvedValue(null);

      const precheck = await validateVoteSubmissionWeight(
         PROPOSAL_ID,
         'walletA',
         1
      );

      expect(precheck.weight).toBe('15');
      expect(precheck.proposalId).toBe(PROPOSAL_ID);
   });

   it('prunes snapshot data when proposals resolve in closeDueProposals', async () => {
      mockPrisma.governanceProposal.findMany.mockResolvedValue([
         makeActiveProposal({
            id: 'p-1',
            totalVotingWeight: '60',
            results: { Yes: '60', No: '0' },
         }),
      ]);
      mockPrisma.governanceProposal.update.mockResolvedValue({});
      mockPrisma.governanceVotingSnapshot.deleteMany.mockResolvedValue({
         count: 4,
      });

      const res = await closeDueProposals(new Date());

      expect(res.prunedSnapshots).toBe(4);
      expect(
         mockPrisma.governanceVotingSnapshot.deleteMany
      ).toHaveBeenCalledWith({
         where: { keyId: KEY_ID, proposalId: PROPOSAL_ID },
      });
   });

   it('records SnapshotTaken event balances and updates proposal snapshotTotalWeight', async () => {
      mockPrisma.governanceProposal.findUnique.mockResolvedValue(
         makeActiveProposal()
      );
      mockPrisma.governanceVotingSnapshot.deleteMany.mockResolvedValue({
         count: 0,
      });
      mockPrisma.governanceVotingSnapshot.createMany.mockResolvedValue({
         count: 2,
      });
      mockPrisma.governanceProposal.update.mockResolvedValue({});

      const indexed = await recordProposalSnapshot({
         keyId: KEY_ID,
         proposalId: PROPOSAL_ID,
         snapshotLedger: 5000,
         balances: [
            { wallet: 'walletA', balance: '30' },
            { wallet: 'walletB', balance: '20' },
            { wallet: 'walletZero', balance: '0' },
         ],
      });

      expect(indexed).toEqual({
         keyId: KEY_ID,
         proposalId: PROPOSAL_ID,
         walletsIndexed: 2,
         snapshotTotalWeight: '50',
      });
      expect(mockPrisma.governanceProposal.update).toHaveBeenCalledWith({
         where: { keyId_proposalId: { keyId: KEY_ID, proposalId: PROPOSAL_ID } },
         data: {
            snapshotTotalWeight: '50',
            snapshotLedger: 5000,
         },
      });
   });
});

