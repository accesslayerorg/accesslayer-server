import { getPaginatedCreators } from './creator.service';
import { prisma } from '../../utils/prisma.utils';
import { CreatorSortOptions } from './creator.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findMany: jest.fn(),
         count: jest.fn(),
      },
   },
}));

const findMany = prisma.creatorProfile.findMany as jest.Mock;
const count = prisma.creatorProfile.count as jest.Mock;

const baseSort: CreatorSortOptions = { field: 'createdAt', order: 'desc' };

function makeCreator(overrides: Record<string, unknown> = {}) {
   return {
      id: 'creator-1',
      userId: 'user-1',
      handle: 'alice',
      displayName: 'Alice',
      bio: null,
      avatarUrl: null,
      perkSummary: null,
      isVerified: false,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
      user: { avatar: null, firstName: 'Alice', lastName: 'A' },
      ...overrides,
   };
}

describe('getPaginatedCreators', () => {
   beforeEach(() => {
      findMany.mockReset();
      count.mockReset();
   });

   it('translates page/limit into the correct skip and take', async () => {
      findMany.mockResolvedValue([]);
      count.mockResolvedValue(0);

      await getPaginatedCreators({ page: 3, limit: 20, sort: baseSort });

      expect(findMany).toHaveBeenCalledWith(
         expect.objectContaining({
            skip: 40, // (3 - 1) * 20
            take: 20,
            orderBy: { createdAt: 'desc' },
         })
      );
   });

   it('returns the resolved creators and the matching pagination metadata', async () => {
      const creators = [
         makeCreator(),
         makeCreator({ id: 'creator-2', handle: 'bob' }),
      ];
      findMany.mockResolvedValue(creators);
      count.mockResolvedValue(35);

      const result = await getPaginatedCreators({
         page: 2,
         limit: 10,
         sort: baseSort,
      });

      expect(result.creators).toEqual(creators);
      expect(result.meta).toEqual({
         page: 2,
         limit: 10,
         totalCount: 35,
         totalPages: 4,
         hasNextPage: true,
         hasPrevPage: true,
      });
   });

   it('flags hasNextPage=false when on the last page', async () => {
      findMany.mockResolvedValue([makeCreator()]);
      count.mockResolvedValue(15);

      const result = await getPaginatedCreators({
         page: 2,
         limit: 10,
         sort: baseSort,
      });

      expect(result.meta.hasNextPage).toBe(false);
      expect(result.meta.hasPrevPage).toBe(true);
      expect(result.meta.totalPages).toBe(2);
   });

   it('flags hasPrevPage=false when on the first page', async () => {
      findMany.mockResolvedValue([makeCreator()]);
      count.mockResolvedValue(15);

      const result = await getPaginatedCreators({
         page: 1,
         limit: 10,
         sort: baseSort,
      });

      expect(result.meta.hasPrevPage).toBe(false);
      expect(result.meta.hasNextPage).toBe(true);
   });

   it('returns zero pages and an empty list when there are no creators', async () => {
      findMany.mockResolvedValue([]);
      count.mockResolvedValue(0);

      const result = await getPaginatedCreators({
         page: 1,
         limit: 10,
         sort: baseSort,
      });

      expect(result.creators).toEqual([]);
      expect(result.meta).toEqual({
         page: 1,
         limit: 10,
         totalCount: 0,
         totalPages: 0,
         hasNextPage: false,
         hasPrevPage: false,
      });
   });

   it('runs findMany and count in parallel', async () => {
      findMany.mockResolvedValue([]);
      count.mockResolvedValue(0);

      await getPaginatedCreators({ page: 1, limit: 10, sort: baseSort });

      expect(findMany).toHaveBeenCalledTimes(1);
      expect(count).toHaveBeenCalledTimes(1);
   });

   it('applies the requested sort field and order', async () => {
      findMany.mockResolvedValue([]);
      count.mockResolvedValue(0);

      await getPaginatedCreators({
         page: 1,
         limit: 10,
         sort: { field: 'displayName', order: 'asc' },
      });

      expect(findMany).toHaveBeenCalledWith(
         expect.objectContaining({ orderBy: { displayName: 'asc' } })
      );
   });
});
