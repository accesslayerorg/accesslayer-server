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
            amount: '0',
            status: 'active',
         },
      });
   });

   it('updates sharePercent on LP_ADDED when a position already exists', async () => {
      _mockTx.lpPosition.findFirst.mockResolvedValue({
         id: 'pos-1',
         status: 'active',
      });

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
         data: {
            sharePercent: '20',
            amount: { increment: '0' },
            status: 'active',
         },
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
         data: { status: 'removed', amount: 0 },
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

   it('LiquidityAdded creates a position (alias works)', async () => {
      _mockTx.lpPosition.findFirst.mockResolvedValue(null);

      const event = {
         eventType: 'LiquidityAdded',
         txHash: 'tx-alias-1',
         eventIndex: 0,
         ledger: 100,
         wallet: 'wallet-alias',
         keyId: 'key-alias',
         sharePercent: '15',
         amount: '500',
      };

      await processLpEvents([event]);

      expect(_mockTx.lpEventLog.create).toHaveBeenCalledWith({
         data: {
            txHash: 'tx-alias-1',
            eventIndex: 0,
            eventType: 'LP_ADDED',
         },
      });
      expect(_mockTx.lpPosition.create).toHaveBeenCalledWith({
         data: {
            wallet: 'wallet-alias',
            keyId: 'key-alias',
            sharePercent: '15',
            amount: '500',
            status: 'active',
         },
      });
   });

   it('RewardsClaimed adds to accruedRewards (alias works)', async () => {
      _mockTx.lpPosition.findFirst.mockResolvedValue({ id: 'pos-alias-2' });

      const event = {
         eventType: 'RewardsClaimed',
         txHash: 'tx-alias-2',
         eventIndex: 0,
         ledger: 100,
         wallet: 'wallet-alias',
         keyId: 'key-alias',
         rewardAmount: '12.5',
      };

      await processLpEvents([event]);

      expect(_mockTx.lpEventLog.create).toHaveBeenCalledWith({
         data: {
            txHash: 'tx-alias-2',
            eventIndex: 0,
            eventType: 'LP_CLAIMED',
         },
      });
      expect(_mockTx.lpPosition.update).toHaveBeenCalledWith({
         where: { id: 'pos-alias-2' },
         data: { accruedRewards: { increment: '12.5' } },
      });
   });

   it('LiquidityRemoved marks the position removed and zeroes amount', async () => {
      _mockTx.lpPosition.findFirst.mockResolvedValue({ id: 'pos-alias-3' });

      const event = {
         eventType: 'LiquidityRemoved',
         txHash: 'tx-alias-3',
         eventIndex: 0,
         ledger: 100,
         wallet: 'wallet-alias',
         keyId: 'key-alias',
      };

      await processLpEvents([event]);

      expect(_mockTx.lpEventLog.create).toHaveBeenCalledWith({
         data: {
            txHash: 'tx-alias-3',
            eventIndex: 0,
            eventType: 'LP_REMOVED',
         },
      });
      expect(_mockTx.lpPosition.update).toHaveBeenCalledWith({
         where: { id: 'pos-alias-3' },
         data: { status: 'removed', amount: 0 },
      });
   });

   it('A second LP_ADDED on an active position increases amount', async () => {
      _mockTx.lpPosition.findFirst.mockResolvedValue({
         id: 'pos-active',
         status: 'active',
      });

      const event: LpChainEvent = {
         eventType: 'LP_ADDED',
         txHash: 'tx-inc',
         eventIndex: 0,
         ledger: 100,
         wallet: 'wallet-1',
         keyId: 'key-1',
         sharePercent: '25',
         amount: '100',
      };

      await processLpEvents([event]);

      expect(_mockTx.lpPosition.update).toHaveBeenCalledWith({
         where: { id: 'pos-active' },
         data: {
            sharePercent: '25',
            amount: { increment: '100' },
            status: 'active',
         },
      });
   });

   it('LP_ADDED on a removed position resets amount and reactivates it', async () => {
      _mockTx.lpPosition.findFirst.mockResolvedValue({
         id: 'pos-removed',
         status: 'removed',
      });

      const event: LpChainEvent = {
         eventType: 'LP_ADDED',
         txHash: 'tx-reset',
         eventIndex: 0,
         ledger: 100,
         wallet: 'wallet-1',
         keyId: 'key-1',
         sharePercent: '30',
         amount: '250',
      };

      await processLpEvents([event]);

      expect(_mockTx.lpPosition.update).toHaveBeenCalledWith({
         where: { id: 'pos-removed' },
         data: {
            sharePercent: '30',
            amount: '250',
            status: 'active',
         },
      });
   });

   it('An LP_ADDED with a negative or non-numeric amount is skipped', async () => {
      const negativeEvent = {
         eventType: 'LP_ADDED',
         txHash: 'tx-neg',
         eventIndex: 0,
         ledger: 100,
         wallet: 'wallet-1',
         keyId: 'key-1',
         sharePercent: '10',
         amount: '-50',
      };

      const nonNumericEvent = {
         eventType: 'LP_ADDED',
         txHash: 'tx-nan',
         eventIndex: 1,
         ledger: 100,
         wallet: 'wallet-1',
         keyId: 'key-1',
         sharePercent: '10',
         amount: 'not-a-number',
      };

      await processLpEvents([negativeEvent, nonNumericEvent]);

      expect(_mockTx.lpPosition.create).not.toHaveBeenCalled();
      expect(_mockTx.lpPosition.update).not.toHaveBeenCalled();
      expect(_mockTx.lpEventLog.create).not.toHaveBeenCalled();
   });
});
