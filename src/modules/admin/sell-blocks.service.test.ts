import { prisma } from '../../utils/prisma.utils';
import { getSellBlocks, getSellBlocksSummary } from './sell-blocks.service';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      sellBlock: {
         findMany: jest.fn(),
         groupBy: jest.fn(),
      },
   },
}));

const mockSellBlock = prisma.sellBlock as jest.Mocked<typeof prisma.sellBlock>;

describe('sell-blocks service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('filters sell blocks and returns the next cursor when more rows exist', async () => {
      const rows = [{ id: 'one' }, { id: 'two' }, { id: 'three' }] as any[];
      mockSellBlock.findMany.mockResolvedValue(rows);

      const result = await getSellBlocks({
         wallet: 'GSELLER',
         keyId: 'GKEY',
         cursor: 'prior',
         limit: 2,
      });

      expect(mockSellBlock.findMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { wallet: 'GSELLER', keyId: 'GKEY' },
            take: 3,
            skip: 1,
            cursor: { id: 'prior' },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
         })
      );
      expect(result.blocks).toEqual(rows.slice(0, 2));
      expect(result.pagination).toEqual({
         limit: 2,
         hasMore: true,
         nextCursor: 'two',
      });
   });

   it('groups the requested window by wallet and key, ranking repeat wallets first', async () => {
      mockSellBlock.groupBy
         .mockResolvedValueOnce([
            { wallet: 'GREPEAT', _count: { _all: 3 } },
            { wallet: 'GSINGLE', _count: { _all: 1 } },
         ] as any)
         .mockResolvedValueOnce([
            { wallet: 'GREPEAT', keyId: 'GKEY1', _count: { _all: 2 } },
            { wallet: 'GREPEAT', keyId: 'GKEY2', _count: { _all: 1 } },
            { wallet: 'GSINGLE', keyId: 'GKEY1', _count: { _all: 1 } },
         ] as any)
         .mockResolvedValueOnce([
            { keyId: 'GKEY1', _count: { _all: 3 } },
            { keyId: 'GKEY2', _count: { _all: 1 } },
         ] as any);

      const result = await getSellBlocksSummary(
         { window: '24h' },
         new Date('2026-11-23T12:00:00.000Z')
      );

      expect(mockSellBlock.groupBy).toHaveBeenCalledTimes(3);
      expect(mockSellBlock.groupBy).toHaveBeenNthCalledWith(
         1,
         expect.objectContaining({
            by: ['wallet'],
            orderBy: [{ _count: { wallet: 'desc' } }, { wallet: 'asc' }],
         })
      );
      for (const [args] of mockSellBlock.groupBy.mock.calls) {
         expect(args.where).toEqual({
            createdAt: { gte: new Date('2026-11-22T12:00:00.000Z') },
         });
      }
      expect(result).toEqual({
         window: '24h',
         since: '2026-11-22T12:00:00.000Z',
         totalBlocks: 4,
         wallets: [
            {
               wallet: 'GREPEAT',
               count: 3,
               keys: [
                  { keyId: 'GKEY1', count: 2 },
                  { keyId: 'GKEY2', count: 1 },
               ],
            },
            {
               wallet: 'GSINGLE',
               count: 1,
               keys: [{ keyId: 'GKEY1', count: 1 }],
            },
         ],
         keys: [
            { keyId: 'GKEY1', count: 3 },
            { keyId: 'GKEY2', count: 1 },
         ],
      });
   });
});
