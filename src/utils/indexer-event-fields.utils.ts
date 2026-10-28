// src/utils/indexer-event-fields.utils.ts
// Shared field readers for indexer handlers that write append-only event logs
// keyed by chain position (txHash + eventIndex).

import { z } from 'zod';
import { IndexerChainEvent } from './indexer-event-processor.utils';
import { PaginationMetadata } from './api-response.utils';

/** Chain position that makes an event log row unique. */
export const chainPositionSchema = z.object({
   txHash: z.string().min(1),
   eventIndex: z.number().int().nonnegative(),
   ledger: z.number().int().nonnegative(),
});

/** Non-negative integer amount in the contract's smallest unit. */
export const unitAmountSchema = z
   .union([
      z.string().regex(/^(0|[1-9]\d*)$/),
      z.number().int().nonnegative().safe(),
      z.bigint().nonnegative(),
   ])
   .transform(value => BigInt(value));

/** Non-empty string identifier (wallet, invoice id, source, ...). */
export const eventIdentifierSchema = z.string().trim().min(1).max(256);

/**
 * Event time from the chain. Numeric values are unix seconds; strings may be
 * ISO-8601. Throws on an unparseable value rather than guessing a time.
 */
export function eventOccurredAt(event: IndexerChainEvent): Date {
   const raw = event.timestamp ?? event.ledgerClosedAt;
   if (raw === undefined || raw === null) {
      return new Date();
   }
   const numeric =
      typeof raw === 'number' ||
      typeof raw === 'bigint' ||
      (typeof raw === 'string' && /^\d+$/.test(raw));
   const date = numeric
      ? new Date(Number(raw) * 1000)
      : new Date(String(raw));
   if (Number.isNaN(date.getTime())) {
      throw new Error('Invalid chain timestamp');
   }
   return date;
}

/** Builds the standard pagination envelope used by paginated responses. */
export function buildPaginationMetadata({
   page,
   limit,
   totalCount,
}: {
   page: number;
   limit: number;
   totalCount: number;
}): PaginationMetadata {
   const totalPages = Math.ceil(totalCount / limit);
   return {
      page,
      limit,
      totalCount,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
   };
}
