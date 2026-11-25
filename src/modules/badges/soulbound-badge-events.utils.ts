// src/modules/badges/soulbound-badge-events.utils.ts

/**
 * Soulbound badge lifecycle events (#1330, minimal first pass).
 *
 * Full indexing (Prisma models/migration, indexer handlers, holder/issuer
 * API) is out of scope for this pass; this pins the event vocabulary and the
 * idempotency key a future indexer handler must dedupe on, so replayed
 * events never create duplicate awards.
 */
export const SOULBOUND_BADGE_EVENT_TYPES = new Set([
   'badge_awarded',
   'badge_revoked',
   'badge_renounced',
]);

export function soulboundBadgeEventKey(
   txHash: string,
   eventIndex: number
): string {
   return `${txHash}:${eventIndex}`;
}
