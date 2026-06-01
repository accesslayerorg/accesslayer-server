import { getCreatorProfile } from './creator-profile.service';

const findFirstMock = jest.fn();

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findFirst: (...args: unknown[]) => findFirstMock(...args),
      },
   },
}));

describe('creator detail integration - empty social links', () => {
   beforeEach(() => {
      findFirstMock.mockReset();
   });

   it('returns links as an empty array when creator profile is missing', async () => {
      findFirstMock.mockResolvedValue(null);

      const result = await getCreatorProfile('missing-creator');

      expect(Array.isArray(result.links)).toBe(true);
      expect(result.links).toEqual([]);
   });

   it('returns links as an empty array when social links are absent in database payload', async () => {
      findFirstMock.mockResolvedValue({
         id: 'creator-1',
         displayName: 'Creator One',
         bio: 'Bio',
         avatarUrl: 'https://example.com/avatar.png',
         perks: [],
      });

      const result = await getCreatorProfile('creator-1');

      expect(Array.isArray(result.links)).toBe(true);
      expect(result.links).toEqual([]);
   });
});
