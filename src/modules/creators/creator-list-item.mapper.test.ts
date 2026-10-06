jest.mock('../../utils/prisma.utils', () => ({
   prisma: {},
}));

jest.mock('../../utils/price-change.utils', () => ({
   computePriceChange: jest.fn().mockResolvedValue(null),
}));

import { mapCreatorListItem } from './creator-list-item.mapper';
import { createSeededCreatorFixture } from '../../utils/test/seeded-creator-fixtures.utils';

describe('mapCreatorListItem()', () => {
   it('maps the public creator list item shape', async () => {
      const input = createSeededCreatorFixture(1);

      const result = await mapCreatorListItem(input);

      expect(result).toEqual({
         id: 'creator-1',
         name: 'Creator 1',
         avatar: 'https://example.com/avatar-1.png',
         followers: 0,
         createdAt: expect.any(String),
         updatedAt: expect.any(String),
         currentPrice: null,
         price24hAgo: null,
         priceChange24h: null,
         deprecated: false,
      });
   });

   it('flags a deprecated key', async () => {
      const input = createSeededCreatorFixture(2, {
         deprecatedAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      const result = await mapCreatorListItem(input);

      expect(result.deprecated).toBe(true);
   });
});
