import { mapCreatorListItem } from './creator-list-item.mapper';
import { createSeededCreatorFixture } from '../../utils/test/seeded-creator-fixtures.utils';

describe('mapCreatorListItem()', () => {
   it('maps the public creator list item shape', () => {
      const input = createSeededCreatorFixture(1);

      const result = mapCreatorListItem(input);

      expect(result).toEqual({
         id: 'creator-1',
         name: 'Creator 1',
         avatar: 'https://example.com/avatar-1.png',
         followers: 0,
      });
   });
});
