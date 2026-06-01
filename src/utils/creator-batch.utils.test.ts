import { fetchCreatorProfilesByIds, CREATOR_PROFILE_SELECT } from './creator-batch.utils';
import { prisma } from './prisma.utils';

jest.mock('./prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findMany: jest.fn(),
      },
   },
}));

const findMany = prisma.creatorProfile.findMany as jest.Mock;

describe('fetchCreatorProfilesByIds', () => {
   beforeEach(() => {
      findMany.mockReset();
   });

   it('returns records in the same order as the input ids and issues one query', async () => {
      const ids = ['b', 'a', 'c'];

      const createdAt = new Date('2020-01-01T00:00:00.000Z');
      const updatedAt = new Date('2020-02-01T00:00:00.000Z');

      // return records in a different order to ensure we reorder them
      findMany.mockResolvedValueOnce([
         { id: 'a', userId: 'u-a', handle: 'a', displayName: 'A', bio: null, avatarUrl: null, perkSummary: null, isVerified: false, createdAt, updatedAt },
         { id: 'b', userId: 'u-b', handle: 'b', displayName: 'B', bio: null, avatarUrl: null, perkSummary: null, isVerified: true, createdAt, updatedAt },
         { id: 'c', userId: 'u-c', handle: 'c', displayName: 'C', bio: null, avatarUrl: null, perkSummary: null, isVerified: false, createdAt, updatedAt },
      ]);

      const result = await fetchCreatorProfilesByIds(ids);

      expect(findMany).toHaveBeenCalledTimes(1);
      expect(findMany).toHaveBeenCalledWith({
         where: { id: { in: ids } },
         select: CREATOR_PROFILE_SELECT,
      });

      expect(result.map((r) => (r ? r.id : null))).toEqual(ids);
   });

   it('returns nulls for missing records preserving order', async () => {
      const ids = ['x', 'y'];
      findMany.mockResolvedValueOnce([{ id: 'y', userId: 'u-y', handle: 'y', displayName: 'Y', bio: null, avatarUrl: null, perkSummary: null, isVerified: false, createdAt: new Date(), updatedAt: new Date() }]);

      const result = await fetchCreatorProfilesByIds(ids);

      expect(findMany).toHaveBeenCalledTimes(1);
      expect(result.map((r) => (r ? r.id : null))).toEqual([null, 'y']);
   });
});
