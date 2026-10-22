import { processTreasuryEvents } from './treasury-indexer.service';
import { prisma } from '../../utils/prisma.utils';
import { cacheInvalidate } from '../../utils/redis.utils';

jest.mock('../../utils/logger.utils', () => ({
   logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/prisma.utils', () => {
   const tx = {
      treasuryInflow: { createMany: jest.fn() },
      treasuryBalance: { upsert: jest.fn() },
   };
   return {
      prisma: {
         $transaction: jest.fn(async (callback: (client: unknown) => unknown) =>
            callback(tx)
         ),
         treasuryAllocation: { createMany: jest.fn() },
         __tx: tx,
      },
   };
});

const tx = (prisma as unknown as { __tx: any }).__tx;

const feeEvent = {
   txHash: 'tx-fee',
   eventIndex: 0,
   ledger: 500,
   eventType: 'FeeReceived',
   source: 'trading',
   amount: '250',
   timestamp: 1_800_000_000,
};

beforeEach(() => {
   jest.clearAllMocks();
   tx.treasuryInflow.createMany.mockResolvedValue({ count: 1 });
   tx.treasuryBalance.upsert.mockResolvedValue({});
   (prisma.treasuryAllocation.createMany as jest.Mock).mockResolvedValue({
      count: 1,
   });
});

describe('processTreasuryEvents', () => {
   it('appends the inflow and increments the source balance for a new FeeReceived', async () => {
      await processTreasuryEvents([feeEvent]);

      expect(tx.treasuryInflow.createMany).toHaveBeenCalledWith({
         data: [
            expect.objectContaining({
               source: 'trading',
               amount: '250',
               txHash: 'tx-fee',
               eventIndex: 0,
               ledger: 500,
            }),
         ],
         skipDuplicates: true,
      });
      expect(tx.treasuryBalance.upsert).toHaveBeenCalledWith({
         where: { source: 'trading' },
         create: { source: 'trading', balance: '250' },
         update: { balance: { increment: '250' } },
      });
      expect(cacheInvalidate).toHaveBeenCalledWith('treasury:*');
   });

   it('does not change any balance when the inflow is a replay', async () => {
      tx.treasuryInflow.createMany.mockResolvedValue({ count: 0 });

      await processTreasuryEvents([feeEvent]);

      expect(tx.treasuryBalance.upsert).not.toHaveBeenCalled();
   });

   it('records FundsAllocated as an outflow without touching balances', async () => {
      await processTreasuryEvents([
         {
            txHash: 'tx-alloc',
            eventIndex: 1,
            ledger: 501,
            eventType: 'FundsAllocated',
            destination: 'GDESTINATION',
            amount: 100,
            purpose: 'grants',
            timestamp: 1_800_000_100,
         },
      ]);

      expect(prisma.treasuryAllocation.createMany).toHaveBeenCalledWith({
         data: [
            expect.objectContaining({
               destination: 'GDESTINATION',
               amount: '100',
               purpose: 'grants',
            }),
         ],
         skipDuplicates: true,
      });
      expect(tx.treasuryBalance.upsert).not.toHaveBeenCalled();
   });

   it('skips a FeeReceived with a non-integer amount', async () => {
      await processTreasuryEvents([{ ...feeEvent, amount: '2.5' }]);

      expect(tx.treasuryInflow.createMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
   });

   it('ignores unrelated event types', async () => {
      await processTreasuryEvents([
         { ...feeEvent, eventType: 'KEY_BOUGHT' },
      ]);

      expect(prisma.$transaction).not.toHaveBeenCalled();
   });
});
