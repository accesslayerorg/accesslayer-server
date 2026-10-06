// src/modules/indexer/lp-indexer.service.test.ts
import { processLpEvents, LpChainEvent } from './lp-indexer.service';

jest.mock('../../utils/prisma.utils', () => {
   const mockTx = {
      lpEventLog: { create: jest.fn() },
      lpPosition: {
         findFirst: jest.fn(),
         create: jest.fn(),
         update: jest.fn(),
      },
   };
   return {
      prisma: {
         $transaction: jest.fn(callback => callback(mockTx)),
         lpPosition: {
            findMany: jest.fn(),
            update: jest.fn(),
         },
      },
      _mockTx: mockTx,
   };
});

describe('processLpEvents', () => {
   const { _mockTx } = jest.requireMock('../../utils/prisma.utils');

   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('creates a new LpPosition on LP_ADDED when none exists', async () => {
      _mockTx.lpPosition.findFirst.mockResolvedValue(null);

      const event: LpChainEvent = {
         eventType: 'LP_ADDED',
         txHash: 'tx-1',
         eventIndex: 0,
         ledger: 100,
         wallet: 'wallet-1',
         keyId: 'key-1',
         sharePercent: '10',
      };

      await processLpEvents([event]);

      expect(_mockTx.lpPosition.create).toHaveBeenCalledWith({
         data: {
            wallet: 'wallet-1',
            keyId: 'key-1',
            sharePercent: '10',
            status: 'active',
         },
      });
   });

   it('updates sharePercent on LP_ADDED when a position already exists', async () => {
      _mockTx.lpPosition.findFirst.mockResolvedValue({ id: 'pos-1' });

      const event: LpChainEvent = {
         eventType: 'LP_ADDED',
         txHash: 'tx-2',
         eventIndex: 0,
         ledger: 100,
         wallet: 'wallet-1',
         keyId: 'key-1',
         sharePercent: '20',
      };

      await processLpEvents([event]);

      expect(_mockTx.lpPosition.update).toHaveBeenCalledWith({
         where: { id: 'pos-1' },
         data: { sharePercent: '20', status: 'active' },
      });
   });

   it('increments accruedRewards on LP_CLAIMED', async () => {
      _mockTx.lpPosition.findFirst.mockResolvedValue({ id: 'pos-1' });

      const event: LpChainEvent = {
         eventType: 'LP_CLAIMED',
         txHash: 'tx-3',
         eventIndex: 0,
         ledger: 100,
         wallet: 'wallet-1',
         keyId: 'key-1',
         rewardAmount: '5',
      };

      await processLpEvents([event]);

      expect(_mockTx.lpPosition.update).toHaveBeenCalledWith({
         where: { id: 'pos-1' },
         data: { accruedRewards: { increment: '5' } },
      });
   });

   it('sets status to removed on LP_REMOVED', async () => {
      _mockTx.lpPosition.findFirst.mockResolvedValue({ id: 'pos-1' });

      const event: LpChainEvent = {
         eventType: 'LP_REMOVED',
         txHash: 'tx-4',
         eventIndex: 0,
         ledger: 100,
         wallet: 'wallet-1',
         keyId: 'key-1',
      };

      await processLpEvents([event]);

      expect(_mockTx.lpPosition.update).toHaveBeenCalledWith({
         where: { id: 'pos-1' },
         data: { status: 'removed' },
      });
   });

   it('skips invalid events without throwing', async () => {
      const badEvent = {
         eventType: 'LP_ADDED',
         txHash: 'tx-5',
         eventIndex: 0,
         ledger: 100,
         wallet: '',
         keyId: 'key-1',
         sharePercent: '10',
      } as LpChainEvent;

      await expect(processLpEvents([badEvent])).resolves.not.toThrow();
      expect(_mockTx.lpPosition.create).not.toHaveBeenCalled();
   });
});
