// src/modules/indexer/governance-proposal-indexer.service.test.ts
import {
   processGovernanceProposalCreatedEvents,
   processGovernanceVoteCastEvents,
   processGovernanceProposalExecutedEvents,
   processGovernanceProposalEvents,
   ProposalCreatedChainEvent,
   VoteCastChainEvent,
   ProposalExecutedChainEvent,
} from './governance-proposal-indexer.service';

jest.mock('../../utils/prisma.utils', () => {
   const prisma: any = {
      governanceProposal: {
         findUnique: jest.fn(),
         create: jest.fn(),
         update: jest.fn(),
      },
      governanceVote: {
         findUnique: jest.fn(),
         findMany: jest.fn(),
         create: jest.fn(),
      },
      indexedLedger: { findFirst: jest.fn() },
      $transaction: jest.fn(),
   };
   prisma.$transaction.mockImplementation(async (cb: any) =>
      typeof cb === 'function' ? cb(prisma) : Promise.all(cb)
   );
   return { prisma, _mockPrisma: prisma };
});

describe('governance proposal indexer', () => {
   const { _mockPrisma: mock } = jest.requireMock(
      '../../utils/prisma.utils'
   );

   beforeEach(() => {
      jest.clearAllMocks();
      mock.$transaction.mockImplementation(async (cb: any) =>
         typeof cb === 'function' ? cb(mock) : Promise.all(cb)
      );
      mock.governanceProposal.findUnique.mockResolvedValue(null);
      mock.governanceVote.findUnique.mockResolvedValue(null);
      mock.indexedLedger.findFirst.mockResolvedValue({ ledger: 555 });
   });

   function createdEvent(
      overrides: Partial<ProposalCreatedChainEvent> = {}
   ): ProposalCreatedChainEvent {
      return {
         eventType: 'PROPOSAL_CREATED',
         txHash: 'tx-created',
         eventIndex: 0,
         ledger: 100,
         keyId: 'key-1',
         proposalId: 'prop-1',
         title: 'Treasury',
         options: ['Yes', 'No'],
         expiresAt: '2026-11-01T00:00:00.000Z',
         quorumBps: 3000,
         ...overrides,
      };
   }

   function voteEvent(
      overrides: Partial<VoteCastChainEvent> = {}
   ): VoteCastChainEvent {
      return {
         eventType: 'VOTE_CAST',
         txHash: 'tx-vote',
         eventIndex: 1,
         ledger: 101,
         keyId: 'key-1',
         proposalId: 'prop-1',
         voter: 'walletA',
         optionIndex: 0,
         weight: '7',
         ...overrides,
      };
   }

   describe('PROPOSAL_CREATED', () => {
      it('creates the proposal with zeroed tallies', async () => {
         await processGovernanceProposalCreatedEvents([createdEvent()]);

         expect(mock.governanceProposal.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
               keyId: 'key-1',
               proposalId: 'prop-1',
               title: 'Treasury',
               options: ['Yes', 'No'],
               totalVotingWeight: '0',
               results: { Yes: '0', No: '0' },
               quorumBps: 3000,
               status: 'active',
            }),
         });
      });

      it('accepts the PascalCase event name', async () => {
         await processGovernanceProposalCreatedEvents([
            createdEvent({ eventType: 'ProposalCreated' }),
         ]);

         expect(mock.governanceProposal.create).toHaveBeenCalled();
      });

      it('uses the latest indexed ledger when none is provided', async () => {
         await processGovernanceProposalCreatedEvents([createdEvent()]);

         expect(mock.indexedLedger.findFirst).toHaveBeenCalled();
         expect(mock.governanceProposal.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ snapshotLedger: 555 }),
         });
      });

      it('skips when the proposal already exists', async () => {
         mock.governanceProposal.findUnique.mockResolvedValue({ id: 'x' });

         await processGovernanceProposalCreatedEvents([createdEvent()]);

         expect(mock.governanceProposal.create).not.toHaveBeenCalled();
      });

      it('skips events missing keyId/proposalId', async () => {
         await processGovernanceProposalCreatedEvents([
            createdEvent({ keyId: '' }),
         ]);

         expect(mock.governanceProposal.create).not.toHaveBeenCalled();
      });
   });

   describe('VOTE_CAST', () => {
      beforeEach(() => {
         mock.governanceProposal.findUnique.mockResolvedValue({
            options: ['Yes', 'No'],
            totalVotingWeight: '0',
            results: { Yes: '0', No: '0' },
         });
      });

      it('records the vote and folds the weight into the tally', async () => {
         await processGovernanceVoteCastEvents([voteEvent()]);

         expect(mock.governanceVote.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
               keyId: 'key-1',
               proposalId: 'prop-1',
               voter: 'walletA',
               optionIndex: 0,
            }),
         });
         expect(mock.governanceProposal.update).toHaveBeenCalledWith({
            where: {
               keyId_proposalId: { keyId: 'key-1', proposalId: 'prop-1' },
            },
            data: {
               totalVotingWeight: '7',
               results: { Yes: '7', No: '0' },
            },
         });
      });

      it('accepts the `wallet` alias and PascalCase event name', async () => {
         await processGovernanceVoteCastEvents([
            voteEvent({
               eventType: 'VoteCast',
               voter: undefined,
               wallet: 'walletB',
            }),
         ]);

         expect(mock.governanceVote.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ voter: 'walletB' }),
         });
      });

      it('skips duplicate votes', async () => {
         mock.governanceVote.findUnique.mockResolvedValue({ id: 'vote-1' });

         await processGovernanceVoteCastEvents([voteEvent()]);

         expect(mock.governanceVote.create).not.toHaveBeenCalled();
         expect(mock.governanceProposal.update).not.toHaveBeenCalled();
      });

      it('records the vote without a tally update when the proposal is unknown', async () => {
         mock.governanceProposal.findUnique.mockResolvedValue(null);

         await processGovernanceVoteCastEvents([voteEvent()]);

         expect(mock.governanceVote.create).toHaveBeenCalled();
         expect(mock.governanceProposal.update).not.toHaveBeenCalled();
      });

      it('skips events with an invalid weight', async () => {
         await processGovernanceVoteCastEvents([
            voteEvent({ weight: 'not-a-number' }),
         ]);

         expect(mock.governanceVote.create).not.toHaveBeenCalled();
      });
   });

   describe('PROPOSAL_EXECUTED', () => {
      function executedEvent(
         overrides: Partial<ProposalExecutedChainEvent> = {}
      ): ProposalExecutedChainEvent {
      return {
         eventType: 'PROPOSAL_EXECUTED',
         txHash: 'tx-exec',
         eventIndex: 2,
         ledger: 102,
         keyId: 'key-1',
         proposalId: 'prop-1',
         executedAt: '2026-11-01T00:00:00.000Z',
         ...overrides,
      };
      }

      it('marks the proposal executed', async () => {
         mock.governanceProposal.findUnique.mockResolvedValue({
            id: 'x',
            status: 'passed',
            executedAt: null,
         });

         await processGovernanceProposalExecutedEvents([executedEvent()]);

         expect(mock.governanceProposal.update).toHaveBeenCalledWith({
            where: {
               keyId_proposalId: { keyId: 'key-1', proposalId: 'prop-1' },
            },
            data: expect.objectContaining({
               status: 'executed',
               executedAt: new Date('2026-11-01T00:00:00.000Z'),
            }),
         });
      });

      it('skips an already executed proposal', async () => {
         mock.governanceProposal.findUnique.mockResolvedValue({
            id: 'x',
            status: 'executed',
            executedAt: new Date('2026-10-01T00:00:00.000Z'),
         });

         await processGovernanceProposalExecutedEvents([executedEvent()]);

         expect(mock.governanceProposal.update).not.toHaveBeenCalled();
      });

      it('skips when the proposal is unknown', async () => {
         mock.governanceProposal.findUnique.mockResolvedValue(null);

         await processGovernanceProposalExecutedEvents([executedEvent()]);

         expect(mock.governanceProposal.update).not.toHaveBeenCalled();
      });
   });

   describe('processGovernanceProposalEvents', () => {
      it('routes all lifecycle events in a mixed batch', async () => {
         mock.governanceProposal.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
               options: ['Yes', 'No'],
               totalVotingWeight: '0',
               results: { Yes: '0', No: '0' },
            })
            .mockResolvedValueOnce({
               id: 'x',
               status: 'passed',
               executedAt: null,
            });

         await processGovernanceProposalEvents([
            createdEvent(),
            voteEvent(),
            {
               eventType: 'PROPOSAL_EXECUTED',
               txHash: 'tx-exec',
               eventIndex: 2,
               ledger: 102,
               keyId: 'key-1',
               proposalId: 'prop-1',
               executedAt: '2026-11-01T00:00:00.000Z',
            } as ProposalExecutedChainEvent,
         ]);

         expect(mock.governanceProposal.create).toHaveBeenCalled();
         expect(mock.governanceVote.create).toHaveBeenCalled();
         expect(mock.governanceProposal.update).toHaveBeenCalledWith(
            expect.objectContaining({
               data: expect.objectContaining({ status: 'executed' }),
            })
         );
      });
   });
});
