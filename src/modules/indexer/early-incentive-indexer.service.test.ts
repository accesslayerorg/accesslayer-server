import { processEarlySlotFilledEvents } from './early-incentive-indexer.service';
import { prisma } from '../../utils/prisma.utils';
import { cacheInvalidate } from '../../utils/redis.utils';

jest.mock('../../utils/logger.utils', () => ({
   logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      invoiceEarlySlotEvent: {
         createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
   },
}));

const base = { txHash: 'tx-slot', eventIndex: 2, ledger: 700, timestamp: 1_800_000_000 };

beforeEach(() => {
   jest.clearAllMocks();
});

describe('processEarlySlotFilledEvents', () => {
   it('appends one slot-fill row keyed by chain position', async () => {
      await processEarlySlotFilledEvents([
         {
            ...base,
            eventType: 'EarlySlotFilled',
            invoice_id: 'inv-1',
            slots_total: 10,
            bonus_bps: 250,
            investor: 'GINVESTOR',
         },
      ]);

      expect(prisma.invoiceEarlySlotEvent.createMany).toHaveBeenCalledWith({
         data: [
            expect.objectContaining({
               invoiceId: 'inv-1',
               slotsTotal: 10,
               bonusBps: 250,
               investor: 'GINVESTOR',
               txHash: 'tx-slot',
               eventIndex: 2,
               ledger: 700,
            }),
         ],
         skipDuplicates: true,
      });
      expect(cacheInvalidate).toHaveBeenCalledWith('invoice:early-incentive:inv-1');
   });

   it('skips a fill whose bonus is outside basis-point range', async () => {
      await processEarlySlotFilledEvents([
         {
            ...base,
            eventType: 'EarlySlotFilled',
            invoice_id: 'inv-1',
            slots_total: 10,
            bonus_bps: 20_000,
         },
      ]);

      expect(prisma.invoiceEarlySlotEvent.createMany).not.toHaveBeenCalled();
   });

   it('ignores unrelated event types', async () => {
      await processEarlySlotFilledEvents([
         { ...base, eventType: 'KEY_BOUGHT', invoice_id: 'inv-1' },
      ]);

      expect(prisma.invoiceEarlySlotEvent.createMany).not.toHaveBeenCalled();
   });
});
