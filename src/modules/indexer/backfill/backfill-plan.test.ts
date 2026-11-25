import {
   buildBackfillPlan,
   planShards,
   runKeyFor,
   validateBackfillRequest,
} from './backfill-plan';

const CONTRACT = 'C' + 'A'.repeat(55);

describe('planShards', () => {
   it('splits a 1,000,000 ledger range into exactly the configured shard count', () => {
      const ranges = planShards(1, 1_000_000, 16);

      expect(ranges).toHaveLength(16);
      expect(ranges[0].fromLedger).toBe(1);
      expect(ranges[ranges.length - 1].toLedger).toBe(1_000_000);
   });

   it('produces contiguous, non-overlapping, inclusive ranges that cover every ledger', () => {
      const ranges = planShards(100, 1_000, 7);

      for (let i = 1; i < ranges.length; i += 1) {
         expect(ranges[i].fromLedger).toBe(ranges[i - 1].toLedger + 1);
      }
      const covered = ranges.reduce((sum, r) => sum + (r.toLedger - r.fromLedger + 1), 0);
      expect(covered).toBe(1_000 - 100 + 1);
   });

   it('keeps shard sizes within one ledger of each other', () => {
      const sizes = planShards(1, 10, 3).map(r => r.toLedger - r.fromLedger + 1);
      expect(sizes).toEqual([4, 3, 3]);
   });

   it('returns one shard covering the whole range when shards is 1', () => {
      expect(planShards(5, 9, 1)).toEqual([{ shardIndex: 0, fromLedger: 5, toLedger: 9 }]);
   });
});

describe('validateBackfillRequest', () => {
   it('accepts a well-formed request', () => {
      expect(validateBackfillRequest({ contractId: CONTRACT, fromLedger: 1, toLedger: 10, shards: 2 })).toEqual([]);
   });

   it('reports every problem at once', () => {
      const problems = validateBackfillRequest({
         contractId: 'not-a-contract',
         fromLedger: 0,
         toLedger: -5,
         shards: 0,
      });

      expect(problems).toEqual(
         expect.arrayContaining([
            expect.stringContaining('contractId'),
            expect.stringContaining('fromLedger'),
            expect.stringContaining('toLedger'),
            expect.stringContaining('shards must be'),
         ])
      );
   });

   it('rejects an inverted range', () => {
      expect(validateBackfillRequest({ contractId: CONTRACT, fromLedger: 10, toLedger: 5, shards: 1 })).toEqual([
         'fromLedger must be less than or equal to toLedger',
      ]);
   });

   it('rejects more shards than ledgers', () => {
      expect(validateBackfillRequest({ contractId: CONTRACT, fromLedger: 1, toLedger: 3, shards: 4 })).toEqual([
         'shards cannot exceed the number of ledgers in the range',
      ]);
   });
});

describe('runKeyFor and buildBackfillPlan', () => {
   const request = { contractId: CONTRACT, fromLedger: 1, toLedger: 100, shards: 4 };

   it('derives the same key for the same request, so interrupted runs resume', () => {
      expect(runKeyFor(request)).toBe(runKeyFor({ ...request }));
   });

   it('derives different keys when the range or shard count differs', () => {
      expect(runKeyFor(request)).not.toBe(runKeyFor({ ...request, shards: 5 }));
      expect(runKeyFor(request)).not.toBe(runKeyFor({ ...request, toLedger: 101 }));
   });

   it('builds a plan carrying the run key and shard ranges', () => {
      const plan = buildBackfillPlan(request);

      expect(plan.runKey).toHaveLength(32);
      expect(plan.ranges).toHaveLength(4);
   });

   it('throws with the list of problems for an invalid request', () => {
      expect(() => buildBackfillPlan({ ...request, shards: 0 })).toThrow(/invalid backfill request/);
   });
});
