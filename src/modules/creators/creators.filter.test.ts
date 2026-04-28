// src/modules/creators/creators.filter.test.ts
// Unit tests for creator list filter whitespace normalization.
// Asserts that parseCreatorFilters normalizes inputs consistently with
// the query parser rules defined in creators.query-string.utils.ts.

import { strict as assert } from 'assert';
import { parseCreatorFilters } from './creators.filter';

function run() {
  // --- search: whitespace normalization ---

  // leading/trailing whitespace is trimmed
  assert.deepEqual(parseCreatorFilters({ search: '  jazz  ' }), { search: 'jazz' });

  // internal whitespace collapses to a single space
  assert.deepEqual(parseCreatorFilters({ search: 'jazz   musician' }), { search: 'jazz musician' });

  // tabs and newlines are treated as whitespace
  assert.deepEqual(parseCreatorFilters({ search: '\t jazz \n' }), { search: 'jazz' });

  // whitespace-only input is dropped (no search key in result)
  assert.deepEqual(parseCreatorFilters({ search: '   ' }), {});

  // empty string is dropped
  assert.deepEqual(parseCreatorFilters({ search: '' }), {});

  // undefined search is omitted
  assert.deepEqual(parseCreatorFilters({}), {});

  // normal search passes through unchanged
  assert.deepEqual(parseCreatorFilters({ search: 'alice' }), { search: 'alice' });

  // --- verified: coercion ---

  assert.deepEqual(parseCreatorFilters({ verified: 'true' }), { verified: true });
  assert.deepEqual(parseCreatorFilters({ verified: 'false' }), { verified: false });
  assert.deepEqual(parseCreatorFilters({ verified: true }), { verified: true });

  // --- combined ---

  assert.deepEqual(
    parseCreatorFilters({ verified: 'true', search: '  bob  ' }),
    { verified: true, search: 'bob' }
  );

  // --- unknown keys are rejected ---

  assert.throws(
    () => parseCreatorFilters({ unknown: 'value' }),
    /Unsupported creator filter key\(s\): unknown/
  );

  assert.throws(
    () => parseCreatorFilters({ verified: 'true', extra: '1' }),
    /Unsupported creator filter key\(s\): extra/
  );

  console.log('creators.filter whitespace normalization tests passed');
}

run();
