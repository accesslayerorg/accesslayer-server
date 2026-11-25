// src/modules/indexer/backfill/backfill-source.ts
// Where backfill events come from (#1337).
//
// Raw Soroban events are decoded by the external indexer worker, not by this
// server (see docs/indexer/ARCHITECTURE.md). The backfill therefore reads the
// already-decoded events from the worker's export endpoint:
//
//   GET {baseUrl}?contractId=C…&fromLedger=n&toLedger=m&limit=200[&cursor=…]
//   200 OK  { "events": [ { "txHash", "eventIndex", "ledger", "eventType", … } ],
//             "nextCursor": "opaque" | null }

export interface BackfillEvent {
   txHash: string;
   eventIndex: number;
   ledger: number;
   eventType: string;
   [key: string]: unknown;
}

export interface BackfillPageQuery {
   contractId: string;
   fromLedger: number;
   toLedger: number;
   cursor: string | null;
   limit: number;
}

export interface BackfillPage {
   events: BackfillEvent[];
   nextCursor: string | null;
}

export interface BackfillEventSource {
   fetchPage(query: BackfillPageQuery): Promise<BackfillPage>;
}

/** Raised when the source returns a response the backfill cannot trust. */
export class BackfillSourceError extends Error {
   constructor(message: string) {
      super(message);
      this.name = 'BackfillSourceError';
   }
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
   ok: boolean;
   status: number;
   json(): Promise<unknown>;
}>;

/**
 * Checks every event before it reaches the database. A malformed or
 * out-of-range event fails the whole shard, so bad data never half-applies.
 */
export function validatePage(raw: unknown, query: BackfillPageQuery): BackfillPage {
   if (!raw || typeof raw !== 'object') {
      throw new BackfillSourceError('source response is not an object');
   }
   const body = raw as { events?: unknown; nextCursor?: unknown };
   if (!Array.isArray(body.events)) {
      throw new BackfillSourceError('source response is missing an events array');
   }
   if (body.nextCursor !== null && body.nextCursor !== undefined && typeof body.nextCursor !== 'string') {
      throw new BackfillSourceError('nextCursor must be a string or null');
   }

   const events = body.events.map((item, position): BackfillEvent => {
      const event = item as Partial<BackfillEvent>;
      if (typeof event.txHash !== 'string' || event.txHash.length === 0) {
         throw new BackfillSourceError(`event ${position} has no txHash`);
      }
      if (!Number.isInteger(event.eventIndex) || (event.eventIndex as number) < 0) {
         throw new BackfillSourceError(`event ${event.txHash} has an invalid eventIndex`);
      }
      if (!Number.isInteger(event.ledger)) {
         throw new BackfillSourceError(`event ${event.txHash}:${event.eventIndex} has no ledger`);
      }
      if ((event.ledger as number) < query.fromLedger || (event.ledger as number) > query.toLedger) {
         throw new BackfillSourceError(
            `event ${event.txHash}:${event.eventIndex} is in ledger ${event.ledger}, outside ${query.fromLedger}-${query.toLedger}`
         );
      }
      if (typeof event.eventType !== 'string' || event.eventType.length === 0) {
         throw new BackfillSourceError(`event ${event.txHash}:${event.eventIndex} has no eventType`);
      }
      return event as BackfillEvent;
   });

   return { events, nextCursor: (body.nextCursor as string | null | undefined) ?? null };
}

export interface HttpEventSourceOptions {
   baseUrl: string;
   timeoutMs?: number;
   fetchImpl?: FetchLike;
}

/** Event source backed by the indexer worker's export endpoint. */
export function createHttpEventSource(options: HttpEventSourceOptions): BackfillEventSource {
   const timeoutMs = options.timeoutMs ?? 10_000;
   const fetchImpl: FetchLike =
      options.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>);

   return {
      async fetchPage(query) {
         const url = new URL(options.baseUrl);
         url.searchParams.set('contractId', query.contractId);
         url.searchParams.set('fromLedger', String(query.fromLedger));
         url.searchParams.set('toLedger', String(query.toLedger));
         url.searchParams.set('limit', String(query.limit));
         if (query.cursor) url.searchParams.set('cursor', query.cursor);

         const controller = new AbortController();
         const timer = setTimeout(() => controller.abort(), timeoutMs);
         try {
            const response = await fetchImpl(url.toString(), { signal: controller.signal });
            if (!response.ok) {
               throw new BackfillSourceError(`event source returned HTTP ${response.status}`);
            }
            return validatePage(await response.json(), query);
         } finally {
            clearTimeout(timer);
         }
      },
   };
}
