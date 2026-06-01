import { strict as assert } from 'assert';
import { normalizeCreatorListPage } from './creator-list-page.guard';

function run() {
   assert.equal(normalizeCreatorListPage(undefined), 1);
   assert.equal(normalizeCreatorListPage('abc'), 1);
   assert.equal(normalizeCreatorListPage(-5), 1);
   assert.equal(normalizeCreatorListPage(999, { max: 100 }), 100);
   assert.equal(normalizeCreatorListPage(2), 2);

   console.log('creator-list-page.guard tests passed');
}

run();
