import { strict as assert } from 'assert';
import { mapCreatorListItem } from './creator-list-item.mapper';

function run() {
   const input = { id: '1', displayName: 'John', avatarUrl: null } as any;

   const result = mapCreatorListItem(input);

   assert.deepEqual(result, {
      id: '1',
      name: 'John',
      avatar: null,
      followers: 0,
   });

   console.log('creator-list-item.mapper test passed');
}

run();
