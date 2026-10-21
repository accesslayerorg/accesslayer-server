import { processInstalmentPaidEvents } from './instalment-schedule-indexer.service';
import { prisma } from '../../utils/prisma.utils';
import { cacheInvalidate } from '../../utils/redis.utils';

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      instalmentPayment: {
         findUnique: jest.fn(),
         upsert: jest.fn(),
      },
   },
}));

const base = {
   txHash: 'tx-inst-1',
   eventIndex: 1,
   ledger: 900,
   timestamp: 1_800_000_000,
};

beforeEach(() => {
   jest.clearAllMocks();
});

describe('processInstalmentPaidEvents (#1177)', () => {
   it('indexes InstalmentPaid event into instalment_payments and invalidates cache', async () => {
      (prisma.instalmentPayment.findUnique as jest.Mock).mockResolvedValue(
         null
      );
      (prisma.instalmentPayment.upsert as jest.Mock).mockResolvedValue({
         id: 'inst-1',
      });

      await processInstalmentPaidEvents([
         {
            ...base,
            eventType: 'InstalmentPaid',
            invoice_id: 'inv-1',
            instalment_number: 2,
            total_instalments: 4,
            amount: '500.0000000',
            due_date: '2026-10-25T00:00:00.000Z',
            payer: 'GPAYER',
         },
      ]);

      expect(prisma.instalmentPayment.upsert).toHaveBeenCalledWith(
         expect.objectContaining({
            where: {
               invoiceId_instalmentNumber: {
                  invoiceId: 'inv-1',
                  instalmentNumber: 2,
               },
            },
            create: expect.objectContaining({
               invoiceId: 'inv-1',
               instalmentNumber: 2,
               totalInstalments: 4,
               amount: '500.0000000',
               payer: 'GPAYER',
               txHash: 'tx-inst-1',
               eventIndex: 1,
               ledger: 900,
            }),
         })
      );
      expect(cacheInvalidate).toHaveBeenCalledWith(
         'invoice:schedule:inv-1',
         'invoice:schedule:next:inv-1'
      );
   });

   it('skips duplicate replayed event by (txHash, eventIndex)', async () => {
      (prisma.instalmentPayment.findUnique as jest.Mock).mockResolvedValue({
         id: 'existing-id',
      });

      await processInstalmentPaidEvents([
         {
            ...base,
            eventType: 'InstalmentPaid',
            invoice_id: 'inv-1',
            instalment_number: 1,
            amount: '100',
         },
      ]);

      expect(prisma.instalmentPayment.upsert).not.toHaveBeenCalled();
      expect(cacheInvalidate).toHaveBeenCalledWith(
         'invoice:schedule:inv-1',
         'invoice:schedule:next:inv-1'
      );
   });
});
