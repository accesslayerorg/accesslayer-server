jest.mock('@prisma/client', () => ({ ...jest.requireActual('@prisma/client') }));
jest.mock('../../utils/prisma.utils', () => ({ prisma: {
   polReserve: { findUnique: jest.fn() }, backstop: { findMany: jest.fn(), groupBy: jest.fn() },
} }));
jest.mock('../../utils/redis.utils', () => ({ cacheGetJson: jest.fn(), cacheSetJson: jest.fn() }));
jest.mock('../whitelist/whitelist.service', () => ({ resolveCreatorId: jest.fn() }));
import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { getPolSummary, getKeyBackstops } from './pol.service';

describe('POL reads', () => {
   beforeEach(() => { jest.clearAllMocks(); (cacheGetJson as jest.Mock).mockResolvedValue(null); });
   it('serves a cached reserve without querying and uses TTL30', async () => {
      const cached = { balance: '10', deployedAmount: '2', repaidAmount: '1' };
      (cacheGetJson as jest.Mock).mockResolvedValue(cached);
      expect(await getPolSummary()).toEqual(cached);
      expect(prisma.polReserve.findUnique).not.toHaveBeenCalled();
      (cacheGetJson as jest.Mock).mockResolvedValue(null);
      (prisma.polReserve.findUnique as jest.Mock).mockResolvedValue(null);
      expect(await getPolSummary()).toEqual({ balance: '0', deployedAmount: '0', repaidAmount: '0' });
      expect(cacheSetJson).toHaveBeenCalledWith('protocol:pol', expect.anything(), 30);
   });
   it('preserves large exact amounts and subtracts repayments', async () => {
      const applied = new Prisma.Decimal('170141183460469231731687303715884105727');
      const repaid = new Prisma.Decimal('170141183460469231731687303715884105726');
      (prisma.backstop.findMany as jest.Mock).mockResolvedValue([
         { id: 'b2', type: 'repaid', amount: repaid, ledger: 2, eventIndex: 1, txHash: 'b', timestamp: new Date(0) },
         { id: 'b1', type: 'applied', amount: applied, ledger: 1, eventIndex: 0, txHash: 'a', timestamp: new Date(0) },
      ]);
      (prisma.backstop.groupBy as jest.Mock).mockResolvedValue([
         { type: 'applied', _sum: { amount: applied } }, { type: 'repaid', _sum: { amount: repaid } },
      ]);
      const result = await getKeyBackstops('key-a', 25, 0);
      expect(result.outstandingAmount).toBe('1');
      expect(result.repaymentStatus).toBe('partial');
      expect(result.items[1].amount).toBe('170141183460469231731687303715884105727');
      expect(prisma.backstop.findMany).toHaveBeenCalledWith(expect.objectContaining({
         orderBy: [{ ledger: 'desc' }, { eventIndex: 'desc' }, { id: 'desc' }],
      }));
   });
});
