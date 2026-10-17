// src/modules/indexer/governance-snapshot-indexer.service.test.ts
import {
   processGovernanceSnapshotEvents,
   SnapshotTakenChainEvent,
} from './governance-snapshot-indexer.service';
import * as governanceProposalsService from '../governance/governance-proposals.service';

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

describe('processGovernanceSnapshotEvents (#1036)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   const baseEvent: SnapshotTakenChainEvent = {
      eventType: 'SNAPSHOT_TAKEN',
      txHash: 'tx-snap-1',
      eventIndex: 0,
      ledger: 5100,
      keyId: 'key-1',
      proposalId: 'prop-1',
      balances: [
         { wallet: 'walletA', balance: '40' },
         { wallet: 'walletB', balance: '10' },
      ],
   };

   it('indexes SnapshotTaken events with proposal ID and wallet balances', async () => {
      const spy = jest
         .spyOn(governanceProposalsService, 'recordProposalSnapshot')
         .mockResolvedValueOnce({
            keyId: 'key-1',
            proposalId: 'prop-1',
            walletsIndexed: 2,
            snapshotTotalWeight: '50',
         });

      await processGovernanceSnapshotEvents([baseEvent]);

      expect(spy).toHaveBeenCalledWith({
         keyId: 'key-1',
         proposalId: 'prop-1',
         snapshotLedger: 5100,
         balances: [
            { wallet: 'walletA', balance: '40' },
            { wallet: 'walletB', balance: '10' },
         ],
      });
   });

   it('skips invalid SnapshotTaken events without throwing', async () => {
      const spy = jest.spyOn(
         governanceProposalsService,
         'recordProposalSnapshot'
      );

      await expect(
         processGovernanceSnapshotEvents([
            {
               eventType: 'SNAPSHOT_TAKEN',
               txHash: 'tx-bad',
               eventIndex: 0,
               proposalId: '',
               balances: null as any,
            } as any,
         ])
      ).resolves.not.toThrow();

      expect(spy).not.toHaveBeenCalled();
   });

   it('handles unknown proposals gracefully without throwing', async () => {
      jest
         .spyOn(governanceProposalsService, 'recordProposalSnapshot')
         .mockRejectedValueOnce(
            new governanceProposalsService.GovernanceProposalNotFoundError(
               'prop-1'
            )
         );

      await expect(
         processGovernanceSnapshotEvents([baseEvent])
      ).resolves.not.toThrow();
   });
});
