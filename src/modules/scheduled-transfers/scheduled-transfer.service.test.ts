import { prisma } from '../../utils/prisma.utils';
import { readScheduledTransferLedger } from './scheduled-transfer-ledger.service';
import { listScheduledTransfers } from './scheduled-transfer.service';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: { scheduledTransfer: { findMany: jest.fn() } },
}));
jest.mock('./scheduled-transfer-ledger.service', () => ({
   readScheduledTransferLedger: jest.fn(),
}));

const ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const findMany = prisma.scheduledTransfer.findMany as jest.Mock;
const readLedger = readScheduledTransferLedger as jest.Mock;
const row = (status = 'pending', releaseLedger = 102) => ({
   id: 'transfer-1', sender: ADDRESS, recipient: OTHER, keyId: 'key-1',
   amount: '9007199254740993', releaseLedger, status, scheduledLedger: 80,
   scheduledAt: new Date('2026-11-21T00:00:00Z'), completedAt: null,
});

describe('scheduled transfer wallet queries', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      readLedger.mockResolvedValue({
         ledger: 101, closedAt: new Date('2026-11-21T01:00:00Z'),
         closeIntervalMs: 6000,
      });
   });

   it.each<[string, number, boolean]>([
      ['pending', 100, true], ['pending', 101, true],
      ['pending', 102, false], ['claimed', 100, false],
      ['cancelled', 100, false],
   ])('computes claimable for %s releasing at %i', async (status, release, expected) => {
      findMany.mockResolvedValue([row(status, release)]);
      const result = await listScheduledTransfers(ADDRESS, { direction: 'all', limit: 25 });
      expect(result.items[0].claimable).toBe(expected);
      expect(result.items[0].amount).toBe('9007199254740993');
   });

   it('estimates release from observed ledger close time', async () => {
      findMany.mockResolvedValue([row()]);
      const result = await listScheduledTransfers(ADDRESS, { direction: 'all', limit: 25 });
      expect(result.items[0].estimatedReleaseTime).toBe('2026-11-21T01:00:06.000Z');
   });

   it.each([
      ['incoming', { recipient: ADDRESS }],
      ['outgoing', { sender: ADDRESS }],
      ['all', { OR: [{ sender: ADDRESS }, { recipient: ADDRESS }] }],
   ])('filters the %s side before pagination', async (direction, filter) => {
      findMany.mockResolvedValue([]);
      await listScheduledTransfers(ADDRESS, { direction: direction as 'all', limit: 25 });
      expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
         where: filter, take: 26,
         orderBy: [{ scheduledLedger: 'desc' }, { id: 'desc' }],
      }));
   });

   it('uses a stable composite cursor without returning the extra row', async () => {
      findMany.mockResolvedValue([row(), { ...row(), id: 'transfer-2' }]);
      const first = await listScheduledTransfers(ADDRESS, { direction: 'all', limit: 1 });
      expect(first.items).toHaveLength(1);
      expect(first.meta.hasNextPage).toBe(true);
      findMany.mockResolvedValue([]);
      await listScheduledTransfers(ADDRESS, {
         direction: 'all', limit: 1, cursor: first.meta.nextCursor!,
      });
      expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({
         where: { AND: [
            { OR: [{ sender: ADDRESS }, { recipient: ADDRESS }] },
            { OR: [
               { scheduledLedger: { lt: 80 } },
               { scheduledLedger: 80, id: { lt: 'transfer-1' } },
            ] },
         ] },
      }));
   });

   it('rejects a cursor for another wallet or direction', async () => {
      findMany.mockResolvedValue([row(), { ...row(), id: 'transfer-2' }]);
      const first = await listScheduledTransfers(ADDRESS, { direction: 'all', limit: 1 });
      await expect(listScheduledTransfers(OTHER, {
         direction: 'all', limit: 1, cursor: first.meta.nextCursor!,
      })).rejects.toThrow('Invalid scheduled transfer cursor');
   });

   it('returns empty items and a null cursor for an empty wallet', async () => {
      findMany.mockResolvedValue([]);
      const result = await listScheduledTransfers(ADDRESS, { direction: 'all', limit: 25 });
      expect(result.items).toEqual([]);
      expect(result.meta).toEqual({ limit: 25, hasNextPage: false, nextCursor: null });
   });
});
