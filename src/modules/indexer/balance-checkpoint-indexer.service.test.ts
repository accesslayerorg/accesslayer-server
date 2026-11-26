import {
   processBalanceChangeEvents,
   recordBalanceCheckpoint,
} from './balance-checkpoint-indexer.service';
import { prisma } from '../../utils/prisma.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      balanceCheckpoint: {
         upsert: jest.fn(),
      },
   },
}));

const mockUpsert = (prisma as any).balanceCheckpoint.upsert as jest.Mock;

describe('balance-checkpoint-indexer.service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockUpsert.mockResolvedValue({});
   });

   it('upserts a single checkpoint per (holder, keyId, ledger)', async () => {
      await recordBalanceCheckpoint({
         holder: 'GABC123',
         keyId: 'key-1',
         ledger: 500,
         balance: 42,
         timestamp: new Date('2026-11-01T10:00:00Z'),
      });

      expect(mockUpsert).toHaveBeenCalledTimes(1);
      expect(mockUpsert).toHaveBeenCalledWith({
         where: {
            holder_keyId_ledger: {
               holder: 'GABC123',
               keyId: 'key-1',
               ledger: 500,
            },
         },
         create: expect.objectContaining({
            holder: 'GABC123',
            keyId: 'key-1',
            ledger: 500,
            balance: 42,
         }),
         update: expect.objectContaining({
            balance: 42,
         }),
      });
   });

   it('collapses multiple changes in the same ledger to a single checkpoint write', async () => {
      await processBalanceChangeEvents([
         {
            eventType: 'BALANCE_CHANGED',
            txHash: 'tx1',
            eventIndex: 0,
            holder: 'GABC123',
            keyId: 'key-1',
            ledger: 1000,
            balance: 10,
            timestamp: '2026-11-01T10:00:00Z',
         },
         {
            eventType: 'BALANCE_CHANGED',
            txHash: 'tx2',
            eventIndex: 0,
            holder: 'GABC123',
            keyId: 'key-1',
            ledger: 1000,
            balance: 25,
            timestamp: '2026-11-01T10:00:02Z',
         },
      ]);

      expect(mockUpsert).toHaveBeenCalledTimes(1);
      expect(mockUpsert).toHaveBeenCalledWith(
         expect.objectContaining({
            create: expect.objectContaining({ balance: 25, ledger: 1000 }),
            update: expect.objectContaining({ balance: 25 }),
         })
      );
   });

   it('records both sender and recipient checkpoints for transfer events', async () => {
      await processBalanceChangeEvents([
         {
            eventType: 'KEY_TRANSFERRED',
            txHash: 'tx3',
            eventIndex: 0,
            keyId: 'key-1',
            ledger: 1001,
            fromAddress: 'GSENDER',
            toAddress: 'GRECIP',
            fromBalance: 5,
            toBalance: 15,
            timestamp: '2026-11-01T10:01:00Z',
         },
      ]);

      expect(mockUpsert).toHaveBeenCalledTimes(2);
   });
});
