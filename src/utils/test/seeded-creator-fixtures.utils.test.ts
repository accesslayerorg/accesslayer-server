import { createSeededCreatorFixture } from './seeded-creator-fixtures.utils';

describe('createSeededCreatorFixture', () => {
   it('produces deterministic records for the same seed', () => {
      const first = createSeededCreatorFixture(5);
      const second = createSeededCreatorFixture(5);

      expect(first).toEqual(second);
   });

   it('produces distinct records for different seeds', () => {
      const seedOne = createSeededCreatorFixture(1);
      const seedTwo = createSeededCreatorFixture(2);

      expect(seedOne).not.toEqual(seedTwo);
      expect(seedOne.id).toBe('creator-1');
      expect(seedTwo.id).toBe('creator-2');
   });

   it('derives stable field values from the seed', () => {
      const fixture = createSeededCreatorFixture(3);

      expect(fixture).toMatchObject({
         id: 'creator-3',
         userId: 'user-3',
         handle: 'creator-3',
         displayName: 'Creator 3',
         avatarUrl: 'https://example.com/avatar-3.png',
         bio: 'Bio for creator 3',
         perkSummary: 'Perks for creator 3',
         isVerified: false,
      });
      expect(fixture.updatedAt.getTime()).toBe(
         fixture.createdAt.getTime() + 1000
      );
   });

   it('respects overridden createdAt when deriving updatedAt', () => {
      const customDate = new Date('2025-01-01T00:00:00.000Z');
      const fixture = createSeededCreatorFixture(4, { createdAt: customDate });

      expect(fixture.createdAt).toEqual(customDate);
      expect(fixture.updatedAt.getTime()).toBe(customDate.getTime() + 1000);
   });
});
