// Issue #1157: paginated reserve event history per key.
import { getKeyReserveHistory } from '../reserves.service';
import { prisma } from '../../../utils/prisma.utils';

jest.mock('../../../utils/prisma.utils', () => ({
   prisma: { keyReserveEvent: { findMany: jest.fn(), count: jest.fn() } },
}));
jest.mock('../../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn().mockResolvedValue(null),
   cacheSetJson: jest.fn().mockResolvedValue(undefined),
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../utils/logger.utils', () => ({
   logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../whitelist/whitelist.service', () => ({
   resolveCreatorId: jest.fn().mockResolvedValue('creator-1'),
}));

const mp = prisma as any;

// Mimics Prisma.Decimal#toFixed without pulling the real client into the test.
const decimal = (value: string) => ({ toFixed: (dp: number) => Number(value).toFixed(dp) });

describe('Issue #1157: getKeyReserveHistory', () => {
   beforeEach(() => jest.clearAllMocks());

   it('returns newest-first events mapped to the public shape with pagination metadata', async () => {
      mp.keyReserveEvent.findMany.mockResolvedValueOnce([
         {
            type: 'deployed',
            amount: decimal('2.5'),
            ledger: 101,
            txHash: 'tx-2',
            eventIndex: 0,
            createdAt: new Date('2026-10-21T10:00:00.000Z'),
         },
         {
            type: 'accrued',
            amount: decimal('10'),
            ledger: 100,
            txHash: 'tx-1',
            eventIndex: 3,
            createdAt: new Date('2026-10-20T10:00:00.000Z'),
         },
      ]);
      mp.keyReserveEvent.count.mockResolvedValueOnce(7);

      const result = await getKeyReserveHistory('KEY-1', 2, 0);

      expect(mp.keyReserveEvent.findMany).toHaveBeenCalledWith(
         expect.objectContaining({ where: { keyId: 'creator-1' }, take: 2, skip: 0 })
      );
      expect(result).toEqual({
         key_id: 'creator-1',
         total: 7,
         limit: 2,
         offset: 0,
         items: [
            {
               type: 'deployed',
               amount: '2.5000000',
               ledger: 101,
               tx_hash: 'tx-2',
               event_index: 0,
               date: '2026-10-21T10:00:00.000Z',
            },
            {
               type: 'accrued',
               amount: '10.0000000',
               ledger: 100,
               tx_hash: 'tx-1',
               event_index: 3,
               date: '2026-10-20T10:00:00.000Z',
            },
         ],
      });
   });

   it('returns an empty page (not an error) for a key with no reserve events', async () => {
      mp.keyReserveEvent.findMany.mockResolvedValueOnce([]);
      mp.keyReserveEvent.count.mockResolvedValueOnce(0);

      const result = await getKeyReserveHistory('KEY-2', 50, 100);

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.offset).toBe(100);
   });
});
