// src/modules/creator/stream-claimable.utils.ts

/**
 * Claimable-balance accounting for per-ledger earnings streams (#1331,
 * minimal first pass). Full indexing (Prisma models/migration, indexer
 * handlers, streams/withdrawals API) is out of scope for this pass; this
 * pins the core accrual formula a future StreamService.claimable() must
 * replicate from the contract: rate * non-paused elapsed ledgers, capped by
 * what has actually been funded minus what has already been withdrawn.
 */
export function claimable(params: {
   rate: number;
   startLedger: number;
   currentLedger: number;
   funded: number;
   withdrawn: number;
   pausedLedgers?: number;
}): number {
   const pausedLedgers = params.pausedLedgers ?? 0;
   const elapsed = Math.max(
      0,
      params.currentLedger - params.startLedger - pausedLedgers
   );
   const accrued = params.rate * elapsed;
   const cap = Math.max(0, params.funded - params.withdrawn);
   return Math.min(accrued, cap);
}
