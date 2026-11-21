// src/modules/indexer/governance-escalation-indexer.service.test.ts
import { processGovernanceEscalationEvents } from './governance-escalation-indexer.service';
import { ProposalExtendedChainEvent } from './governance-escalation-indexer.service';

jest.mock('../../utils/prisma.utils', () => {
   const mockTx = {
      governanceEscalationEventLog: {
         create: jest.fn(),
      },
      governanceProposal: {
         findUnique: jest.fn(),
         update: jest.fn(),
      },
   };
   return {
      prisma: {
         $transaction: jest.fn(callback => callback(mockTx)),
      },
      _mockTx: mockTx,
   };
});

describe('processGovernanceEscalationEvents', () => {
   const { _mockTx } = jest.requireMock('../../utils/prisma.utils');

   beforeEach(() => {
      jest.clearAllMocks();
   });

   const baseEvent: ProposalExtendedChainEvent = {
      eventType: 'PROPOSAL_EXTENDED',
      txHash: 'tx-1',
      eventIndex: 0,
      ledger: 1000,
      keyId: 'key-1',
      proposalId: 'prop-1',
      newDeadline: '2026-10-01T00:00:00.000Z',
   };

   it('increments escalationCount and updates deadline fields', async () => {
      _mockTx.governanceProposal.findUnique.mockResolvedValue({
         keyId: 'key-1',
         proposalId: 'prop-1',
         escalationCount: 0,
         maxEscalations: 3,
         expiresAt: new Date('2026-09-01T00:00:00.000Z'),
         originalDeadline: null,
      });

      await processGovernanceEscalationEvents([baseEvent]);

      expect(_mockTx.governanceEscalationEventLog.create).toHaveBeenCalledWith({
         data: {
            keyId: 'key-1',
            proposalId: 'prop-1',
            ledger: 1000,
            txHash: 'tx-1',
            eventIndex: 0,
         },
      });

      expect(_mockTx.governanceProposal.update).toHaveBeenCalledWith({
         where: { keyId_proposalId: { keyId: 'key-1', proposalId: 'prop-1' } },
         data: expect.objectContaining({
            escalationCount: 1,
            originalDeadline: new Date('2026-09-01T00:00:00.000Z'),
            extendedDeadline: new Date('2026-10-01T00:00:00.000Z'),
            expiresAt: new Date('2026-10-01T00:00:00.000Z'),
         }),
      });
   });

   it('skips events missing required fields without throwing', async () => {
      const badEvent = {
         eventType: 'PROPOSAL_EXTENDED',
         txHash: 'tx-2',
         eventIndex: 0,
         ledger: 1000,
         keyId: '',
         proposalId: 'prop-1',
         newDeadline: 'not-a-date',
      } as ProposalExtendedChainEvent;

      await expect(
         processGovernanceEscalationEvents([badEvent])
      ).resolves.not.toThrow();
      expect(_mockTx.governanceProposal.update).not.toHaveBeenCalled();
   });

   it('ignores events for unknown proposals', async () => {
      _mockTx.governanceProposal.findUnique.mockResolvedValue(null);

      await processGovernanceEscalationEvents([baseEvent]);

      expect(_mockTx.governanceProposal.update).not.toHaveBeenCalled();
   });
});
