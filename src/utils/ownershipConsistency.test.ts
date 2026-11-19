import assert from 'node:assert/strict';
import { checkOwnershipReadModelConsistency } from './ownershipConsistency';

test('emits a structured error log when holder balances differ from stored supply', () => {
   const events: Array<Record<string, unknown>> = [];

   const mismatchDetected = checkOwnershipReadModelConsistency({
      creatorId: 'creator-1',
      storedSupply: 100,
      holderBalances: [40, 20],
      detectedAt: new Date('2026-01-01T00:00:00.000Z'),
      logError: entry => events.push(entry),
   });

   assert.equal(mismatchDetected, true);
   assert.equal(events.length, 1);
   assert.deepEqual(events[0], {
      creator_id: 'creator-1',
      stored_supply: 100,
      computed_holder_sum: 60,
      discrepancy: -40,
      detected_at: '2026-01-01T00:00:00.000Z',
   });
});

test('does not emit a log when holder balances match stored supply', () => {
   const events: Array<Record<string, unknown>> = [];

   const mismatchDetected = checkOwnershipReadModelConsistency({
      creatorId: 'creator-2',
      storedSupply: 100,
      holderBalances: [50, 50],
      detectedAt: new Date('2026-01-02T00:00:00.000Z'),
      logError: entry => events.push(entry),
   });

   assert.equal(mismatchDetected, false);
   assert.equal(events.length, 0);
});
