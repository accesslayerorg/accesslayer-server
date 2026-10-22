import { buildEarlyIncentiveStatus } from './invoice-early-incentive.service';

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn().mockResolvedValue(null),
   cacheSetJson: jest.fn().mockResolvedValue(undefined),
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/prisma.utils', () => ({ prisma: {} }));

describe('buildEarlyIncentiveStatus', () => {
   it('reports inactive for an invoice with no incentive configured', () => {
      expect(
         buildEarlyIncentiveStatus({
            invoiceId: 'inv-1',
            slotsTotal: 0,
            bonusBps: 0,
            slotsFilledEvents: 0,
         })
      ).toEqual({
         invoice_id: 'inv-1',
         slots_total: 0,
         slots_filled: 0,
         slots_remaining: 0,
         bonus_bps: 0,
         is_active: false,
      });
   });

   it('derives remaining slots from the fill count', () => {
      expect(
         buildEarlyIncentiveStatus({
            invoiceId: 'inv-1',
            slotsTotal: 10,
            bonusBps: 250,
            slotsFilledEvents: 4,
         })
      ).toEqual({
         invoice_id: 'inv-1',
         slots_total: 10,
         slots_filled: 4,
         slots_remaining: 6,
         bonus_bps: 250,
         is_active: true,
      });
   });

   it('is inactive once every slot is filled', () => {
      const status = buildEarlyIncentiveStatus({
         invoiceId: 'inv-1',
         slotsTotal: 3,
         bonusBps: 100,
         slotsFilledEvents: 3,
      });

      expect(status.slots_remaining).toBe(0);
      expect(status.is_active).toBe(false);
   });

   it('never reports more slots filled than the total', () => {
      const status = buildEarlyIncentiveStatus({
         invoiceId: 'inv-1',
         slotsTotal: 2,
         bonusBps: 100,
         slotsFilledEvents: 5,
      });

      expect(status.slots_filled).toBe(2);
      expect(status.slots_remaining).toBe(0);
   });
});
