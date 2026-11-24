import { BalanceHistoryService } from './balance-history.service';
import { prisma } from '../../utils/prisma.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      balanceCheckpoint: {
         findFirst: jest.fn(),
         findMany: jest.fn(),
      },
      ledgerCheckpoint: {
         findFirst: jest.fn(),
      },
      creatorProfile: {
         findMany: jest.fn(),
      },
   },
}));

const bcFindFirst = (prisma as any).balanceCheckpoint.findFirst as jest.Mock;
const bcFindMany = (prisma as any).balanceCheckpoint.findMany as jest.Mock;
const lcFindFirst = (prisma as any).ledgerCheckpoint.findFirst as jest.Mock;
const cpFindMany = (prisma as any).creatorProfile.findMany as jest.Mock;

describe('BalanceHistoryService', () => {
   const service = new BalanceHistoryService();

   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('at()', () => {
      it('returns 0 when ledger is before the first checkpoint', async () => {
         bcFindFirst.mockResolvedValue(null);

         const res = await service.at('GWALLET', 'key-1', 50);

         expect(bcFindFirst).toHaveBeenCalledWith({
            where: {
               holder: 'GWALLET',
               keyId: 'key-1',
               ledger: { lte: 50 },
            },
            orderBy: { ledger: 'desc' },
         });
         expect(res.balance).toBe(0);
         expect(res.checkpointLedger).toBeNull();
      });

      it('returns exact balance at a checkpoint ledger', async () => {
         bcFindFirst.mockResolvedValue({
            holder: 'GWALLET',
            keyId: 'key-1',
            ledger: 100,
            balance: '15.5',
            timestamp: new Date('2026-11-01T00:00:00Z'),
         });

         const res = await service.at('GWALLET', 'key-1', 100);

         expect(res.balance).toBe(15.5);
         expect(res.checkpointLedger).toBe(100);
      });

      it('returns latest checkpoint balance after a checkpoint ledger', async () => {
         bcFindFirst.mockResolvedValue({
            holder: 'GWALLET',
            keyId: 'key-1',
            ledger: 100,
            balance: '20',
            timestamp: new Date('2026-11-01T00:00:00Z'),
         });

         const res = await service.at('GWALLET', 'key-1', 150);

         expect(res.balance).toBe(20);
         expect(res.checkpointLedger).toBe(100);
      });
   });

   describe('history()', () => {
      it('returns step points with carry-forward at fromLedger', async () => {
         bcFindMany.mockResolvedValue([
            {
               holder: 'GWALLET',
               keyId: 'key-1',
               ledger: 110,
               balance: '30',
               timestamp: new Date('2026-11-01T00:01:00Z'),
            },
         ]);
         bcFindFirst.mockResolvedValue({
            holder: 'GWALLET',
            keyId: 'key-1',
            ledger: 90,
            balance: '10',
            timestamp: new Date('2026-11-01T00:00:00Z'),
         });

         const points = await service.history('GWALLET', 'key-1', 100, 150);

         expect(points).toHaveLength(2);
         expect(points[0]).toEqual({
            ledger: 100,
            balance: 10,
            timestamp: '2026-11-01T00:00:00.000Z',
         });
         expect(points[1]).toEqual({
            ledger: 110,
            balance: 30,
            timestamp: '2026-11-01T00:01:00.000Z',
         });
      });
   });

   describe('portfolioAsOf()', () => {
      it('returns zero holdings for dates before the first checkpoint', async () => {
         lcFindFirst.mockResolvedValue(null);
         bcFindFirst.mockResolvedValue(null);
         bcFindMany.mockResolvedValue([]);

         const result = await service.portfolioAsOf(
            'GWALLET',
            new Date('2020-01-01T00:00:00Z')
         );

         expect(result.holdings).toEqual([]);
         expect(result.approximated).toBe(true);
         expect(result.ledger).toBe(0);
      });

      it('resolves ledger, approximation flag, and non-zero holdings', async () => {
         const completedAt = new Date('2026-11-01T12:00:00Z');
         lcFindFirst.mockResolvedValue({
            ledger: 2000,
            completedAt,
         });
         bcFindMany.mockResolvedValue([
            {
               holder: 'GWALLET',
               keyId: 'key-1',
               ledger: 1950,
               balance: '12',
               timestamp: new Date('2026-11-01T11:55:00Z'),
            },
            {
               holder: 'GWALLET',
               keyId: 'key-2',
               ledger: 1900,
               balance: '0',
               timestamp: new Date('2026-11-01T11:50:00Z'),
            },
         ]);
         cpFindMany.mockResolvedValue([
            { id: 'key-1', handle: 'alice', displayName: 'Alice' },
         ]);

         const asOf = new Date('2026-11-01T12:00:25Z');
         const result = await service.portfolioAsOf('GWALLET', asOf);

         expect(result.ledger).toBe(2005);
         expect(result.approximated).toBe(true);
         expect(result.holdings).toEqual([
            {
               keyId: 'key-1',
               handle: 'alice',
               displayName: 'Alice',
               balance: 12,
               checkpointLedger: 1950,
            },
         ]);
      });
   });
});
