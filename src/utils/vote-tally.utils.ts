// src/utils/vote-tally.utils.ts
//
// Shared, exact vote tally arithmetic for governance proposals.
//
// Vote weights are integer key counts, so `bigint` is used on the raw string
// values to avoid the precision loss that `Number(...)` would incur as totals
// accumulate. Both the key-holder voting flow and the snapshot voting flow
// (#878) fold weights with {@link applyVoteWeight} so the two never diverge.

/**
 * Denormalised tally currently stored on a GovernanceProposal row.
 */
export interface VoteTally {
   totalVotingWeight: string;
   results: Record<string, string>;
}

/**
 * Parses a tally value (stored as a string, or `0` / undefined when unset)
 * into a `bigint` for exact arithmetic.
 */
function toBigInt(value: string | number | undefined | null): bigint {
   if (value === undefined || value === null || value === '') return 0n;
   return typeof value === 'number' ? BigInt(Math.round(value)) : BigInt(value);
}

/**
 * Folds one wallet's `weight` into the proposal's current tallies.
 *
 * Pure: invoked inside the caller's transaction so the read-modify-write of
 * the denormalised totals is atomic with the vote insert. Key counts are
 * integers, so `bigint` avoids floating-point drift as totals accumulate and
 * preserves every existing option bucket.
 */
export function applyVoteWeight(
   current: VoteTally,
   weight: string,
   option: string
): VoteTally {
   const w = toBigInt(weight);
   const currentResults = current.results ?? {};
   const newTotal = toBigInt(current.totalVotingWeight) + w;
   const newOptionWeight = toBigInt(currentResults[option] ?? 0) + w;

   return {
      totalVotingWeight: newTotal.toString(),
      results: {
         ...currentResults,
         [option]: newOptionWeight.toString(),
      },
   };
}
