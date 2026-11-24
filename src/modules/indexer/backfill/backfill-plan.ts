// src/modules/indexer/backfill/backfill-plan.ts
// Pure planning logic for the parallel indexer backfill (#1337). No I/O here,
// so the sharding and run identity rules are cheap to unit test.

import { createHash } from 'crypto';

export const MAX_SHARDS = 1024;

/** Contract ids are Soroban strkeys: "C" followed by 55 base32 characters. */
const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

export interface BackfillRequest {
   contractId: string;
   fromLedger: number;
   toLedger: number;
   shards: number;
}

export interface ShardRange {
   shardIndex: number;
   /** Inclusive. */
   fromLedger: number;
   /** Inclusive. */
   toLedger: number;
}

export interface BackfillPlan extends BackfillRequest {
   runKey: string;
   ranges: ShardRange[];
}

/**
 * Validates a backfill request, returning every problem found (empty when valid).
 * Reporting all problems at once saves a round trip for operators.
 */
export function validateBackfillRequest(request: BackfillRequest): string[] {
   const problems: string[] = [];

   if (!CONTRACT_ID_PATTERN.test(request.contractId)) {
      problems.push('contractId must be a Soroban contract id (C…, 56 characters)');
   }
   if (!Number.isInteger(request.fromLedger) || request.fromLedger < 1) {
      problems.push('fromLedger must be a positive integer');
   }
   if (!Number.isInteger(request.toLedger) || request.toLedger < 1) {
      problems.push('toLedger must be a positive integer');
   }
   if (Number.isInteger(request.fromLedger) && Number.isInteger(request.toLedger) && request.fromLedger > request.toLedger) {
      problems.push('fromLedger must be less than or equal to toLedger');
   }
   if (!Number.isInteger(request.shards) || request.shards < 1 || request.shards > MAX_SHARDS) {
      problems.push(`shards must be an integer between 1 and ${MAX_SHARDS}`);
   } else if (
      Number.isInteger(request.fromLedger) &&
      Number.isInteger(request.toLedger) &&
      request.fromLedger <= request.toLedger &&
      request.shards > request.toLedger - request.fromLedger + 1
   ) {
      problems.push('shards cannot exceed the number of ledgers in the range');
   }

   return problems;
}

/**
 * Splits an inclusive ledger range into `shards` contiguous, non-overlapping
 * inclusive ranges. Earlier shards take the extra ledgers when the division is
 * uneven, so shard sizes differ by at most one.
 */
export function planShards(fromLedger: number, toLedger: number, shards: number): ShardRange[] {
   const total = toLedger - fromLedger + 1;
   const base = Math.floor(total / shards);
   const extra = total % shards;

   const ranges: ShardRange[] = [];
   let cursor = fromLedger;
   for (let shardIndex = 0; shardIndex < shards; shardIndex += 1) {
      const size = base + (shardIndex < extra ? 1 : 0);
      ranges.push({ shardIndex, fromLedger: cursor, toLedger: cursor + size - 1 });
      cursor += size;
   }
   return ranges;
}

/**
 * Stable identifier for a run. The same contract, range and shard count always
 * produce the same key, which is what makes an interrupted run resumable.
 */
export function runKeyFor(request: BackfillRequest): string {
   return createHash('sha256')
      .update(`${request.contractId}:${request.fromLedger}:${request.toLedger}:${request.shards}`)
      .digest('hex')
      .slice(0, 32);
}

/** Validates the request and returns the full plan. Throws listing every problem. */
export function buildBackfillPlan(request: BackfillRequest): BackfillPlan {
   const problems = validateBackfillRequest(request);
   if (problems.length > 0) {
      throw new Error(`invalid backfill request: ${problems.join('; ')}`);
   }
   return {
      ...request,
      runKey: runKeyFor(request),
      ranges: planShards(request.fromLedger, request.toLedger, request.shards),
   };
}
