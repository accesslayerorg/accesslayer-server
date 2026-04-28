// src/utils/filter-parse-metrics.utils.test.ts
// Unit tests for filter parse error metrics counter.

import { strict as assert } from 'assert';
import {
   incrementFilterParseError,
   getFilterParseErrors,
   resetFilterParseMetrics,
} from './filter-parse-metrics.utils';

function run() {
   // Reset before each test
   resetFilterParseMetrics();

   // --- initial state ---
   assert.deepEqual(getFilterParseErrors(), [], 'should start empty');

   // --- single increment ---
   incrementFilterParseError('/api/v1/creators', 'unknown_key');
   const errors = getFilterParseErrors();
   assert.equal(errors.length, 1, 'should have one entry');
   assert.equal(errors[0].route, '/api/v1/creators');
   assert.equal(errors[0].category, 'unknown_key');
   assert.equal(errors[0].count, 1);

   // --- multiple increments same key ---
   incrementFilterParseError('/api/v1/creators', 'unknown_key');
   const errors2 = getFilterParseErrors();
   assert.equal(errors2.length, 1, 'should still have one entry');
   assert.equal(errors2[0].count, 2, 'count should be 2');

   // --- different category ---
   incrementFilterParseError('/api/v1/creators', 'invalid_value');
   const errors3 = getFilterParseErrors();
   assert.equal(errors3.length, 2, 'should have two entries');

   // --- different route ---
   incrementFilterParseError('/api/v1/other', 'unknown_key');
   const errors4 = getFilterParseErrors();
   assert.equal(errors4.length, 3, 'should have three entries');

   // --- reset ---
   resetFilterParseMetrics();
   assert.deepEqual(getFilterParseErrors(), [], 'should be empty after reset');

   console.log('filter-parse-metrics.utils tests passed');
}

run();
