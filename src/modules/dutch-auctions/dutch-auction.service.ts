import { prisma } from '../../utils/prisma.utils';
import { horizonGet } from '../../clients/horizon.client';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { decodeCursor, encodeCursor } from '../../utils/cursor.utils';
import { logger } from '../../utils/logger.utils';
import {
   DUTCH_AUCTION_DEFAULT_LIMIT,
   DUTCH_AUCTION_LIST_CACHE_TTL_SECONDS,
   DUTCH_AUCTION_MAX_LIMIT,
   DutchAuctionStatus,
   SECONDS_PER_LEDGER,
   dutchAuctionListCacheKey,
} from './dutch-auction.constants';
import {
   currentPrice,
   currentPriceStroops,
   endLedger,
   fromStroops,
   toStroops,
} from './dutch-auction-price';

export class DutchAuctionNotFoundError extends Error {
   constructor(id: string) {
      super(`Dutch auction ${id} not found`);
      this.name = 'DutchAuctionNotFoundError';
   }
}

export interface LedgerClock {
   /** Latest known ledger sequence. */
   ledger: number;
   /** When that ledger closed (or our best estimate of it). */
   closedAt: Date;
}

export interface DutchAuctionRow {
   id: string;
   seller: string;
   keyId: string;
   quantity: number;
   remaining: number;
   startPrice: { toString(): string } | string;
   floorPrice: { toString(): string } | string;
   startLedger: number;
   durationLedgers: number;
   status: string;
   fillCount: number;
   createdAt: Date;
   updatedAt: Date;
}

export interface DutchAuctionQuote {
   id: string;
   seller: string;
   keyId: string;
   quantity: number;
   remaining: number;
   startPrice: string;
   floorPrice: string;
   startLedger: number;
   durationLedgers: number;
   endLedger: number;
   status: DutchAuctionStatus;
   currentPrice: string;
   /** Ledger the quote was computed for. */
   quotedAtLedger: number;
   /** Estimated time the price next drops; null once it stops changing. */
   nextPriceChangeAt: string | null;
}

/** Reads the latest ledger and its close time from Horizon, falling back to the indexer. */
export async function getLedgerClock(): Promise<LedgerClock> {
   try {
      const res = await horizonGet('/');
      if (res.ok) {
         const data = (await res.json()) as {
            core_latest_ledger?: number;
            history_latest_ledger?: number;
            history_latest_ledger_closed_at?: string;
         };
         const ledger = data.core_latest_ledger ?? data.history_latest_ledger;
         if (typeof ledger === 'number' && ledger > 0) {
            const closed = data.history_latest_ledger_closed_at
               ? new Date(data.history_latest_ledger_closed_at)
               : new Date();
            return {
               ledger,
               closedAt: Number.isNaN(closed.getTime()) ? new Date() : closed,
            };
         }
      }
   } catch (error) {
      logger.warn(
         {
            type: 'dutch_auction_ledger_lookup_failed',
            error: error instanceof Error ? error.message : String(error),
         },
         'Horizon ledger lookup failed; falling back to indexed ledger'
      );
   }

   const indexed = await prisma.indexedLedger.findFirst();
   if (!indexed) {
      throw new Error('Current ledger is unavailable');
   }
   return { ledger: indexed.ledger, closedAt: indexed.updatedAt };
}

/**
 * Status as of `ledger`. An open auction whose duration has passed with no
 * fills is ended; one that already has fills stays open at the floor price.
 */
export function effectiveStatus(
   row: Pick<
      DutchAuctionRow,
      'status' | 'fillCount' | 'startLedger' | 'durationLedgers'
   >,
   ledger: number
): DutchAuctionStatus {
   if (
      row.status === 'open' &&
      row.fillCount === 0 &&
      ledger >= endLedger(row)
   ) {
      return 'ended';
   }
   return row.status as DutchAuctionStatus;
}

/** Estimated time of the next per-ledger price step, or null if none remains. */
export function nextPriceChangeAt(
   row: DutchAuctionRow,
   status: DutchAuctionStatus,
   clock: LedgerClock
): string | null {
   if (status !== 'open') return null;
   const price = currentPriceStroops(row, clock.ledger);
   if (price <= toStroops(row.floorPrice.toString())) return null;
   const next = new Date(clock.closedAt.getTime() + SECONDS_PER_LEDGER * 1000);
   // Never report a time in the past if the clock reading is stale.
   return new Date(Math.max(next.getTime(), Date.now())).toISOString();
}

export function toQuote(
   row: DutchAuctionRow,
   clock: LedgerClock
): DutchAuctionQuote {
   const status = effectiveStatus(row, clock.ledger);
   const startPrice = fromStroops(toStroops(row.startPrice.toString()));
   const floorPrice = fromStroops(toStroops(row.floorPrice.toString()));
   return {
      id: row.id,
      seller: row.seller,
      keyId: row.keyId,
      quantity: row.quantity,
      remaining: row.remaining,
      startPrice,
      floorPrice,
      startLedger: row.startLedger,
      durationLedgers: row.durationLedgers,
      endLedger: endLedger(row),
      status,
      currentPrice: currentPrice(row, clock.ledger),
      quotedAtLedger: clock.ledger,
      nextPriceChangeAt: nextPriceChangeAt(row, status, clock),
   };
}

/** Persists `ended` for open, unfilled auctions whose duration has passed. */
export async function markEndedAuctions(ledger: number): Promise<number> {
   // startLedger + durationLedgers <= ledger cannot be expressed as a column
   // comparison in updateMany, so select candidates first.
   const candidates = await prisma.dutchAuction.findMany({
      where: { status: 'open', fillCount: 0, startLedger: { lt: ledger } },
      select: { id: true, startLedger: true, durationLedgers: true },
   });
   const ids = candidates
      .filter(
         (a: { startLedger: number; durationLedgers: number }) =>
            ledger >= endLedger(a)
      )
      .map((a: { id: string }) => a.id);
   if (ids.length === 0) return 0;
   const result = await prisma.dutchAuction.updateMany({
      where: { id: { in: ids }, status: 'open', fillCount: 0 },
      data: { status: 'ended' },
   });
   return result.count;
}

export interface ListDutchAuctionsParams {
   keyId?: string;
   /** Defaults to `open`, i.e. the active listing. */
   status?: DutchAuctionStatus;
   cursor?: string;
   limit?: number;
}

export interface DutchAuctionList {
   items: DutchAuctionQuote[];
   nextCursor: string | null;
   hasMore: boolean;
}

interface ListCursor {
   startLedger: number;
   id: string;
}

export async function listDutchAuctions(
   params: ListDutchAuctionsParams,
   getClock: () => Promise<LedgerClock> = getLedgerClock
): Promise<DutchAuctionList> {
   const status = params.status ?? 'open';
   const limit = Math.min(
      Math.max(1, params.limit ?? DUTCH_AUCTION_DEFAULT_LIMIT),
      DUTCH_AUCTION_MAX_LIMIT
   );

   const cacheKey = dutchAuctionListCacheKey({
      keyId: params.keyId,
      status,
      cursor: params.cursor,
      limit,
   });
   const cached = await cacheGetJson<DutchAuctionList>(cacheKey);
   if (cached) return cached;

   // Throws CursorChecksumError for a tampered cursor; the route maps it to 400.
   const after = params.cursor ? decodeCursor<ListCursor>(params.cursor) : null;

   const clock = await getClock();
   await markEndedAuctions(clock.ledger);

   const rows = (await prisma.dutchAuction.findMany({
      where: {
         status,
         ...(params.keyId ? { keyId: params.keyId } : {}),
         ...(after
            ? {
                 OR: [
                    { startLedger: { lt: after.startLedger } },
                    {
                       startLedger: after.startLedger,
                       id: { lt: after.id },
                    },
                 ],
              }
            : {}),
      },
      orderBy: [{ startLedger: 'desc' }, { id: 'desc' }],
      take: limit + 1,
   })) as DutchAuctionRow[];

   const hasMore = rows.length > limit;
   const page = hasMore ? rows.slice(0, limit) : rows;
   const last = page[page.length - 1];
   const result: DutchAuctionList = {
      items: page.map(row => toQuote(row, clock)),
      nextCursor:
         hasMore && last
            ? encodeCursor<ListCursor>({
                 startLedger: last.startLedger,
                 id: last.id,
              })
            : null,
      hasMore,
   };

   await cacheSetJson(cacheKey, result, DUTCH_AUCTION_LIST_CACHE_TTL_SECONDS);
   return result;
}

export async function getDutchAuction(
   id: string,
   getClock: () => Promise<LedgerClock> = getLedgerClock
): Promise<DutchAuctionQuote> {
   const row = (await prisma.dutchAuction.findUnique({
      where: { id },
   })) as DutchAuctionRow | null;
   if (!row) throw new DutchAuctionNotFoundError(id);

   const clock = await getClock();
   const quote = toQuote(row, clock);
   if (quote.status === 'ended' && row.status === 'open') {
      await markEndedAuctions(clock.ledger);
   }
   return quote;
}
