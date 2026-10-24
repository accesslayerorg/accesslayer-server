import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';
import { invalidateSpotlightCache } from '../keys/discovery.service';

const TYPES = new Set([
   'SpotlightBidPlaced',
   'SPOTLIGHT_BID_PLACED',
   'SpotlightAwarded',
   'SPOTLIGHT_AWARDED',
]);

function field(source: Record<string, any>, ...names: string[]): any {
   for (const name of names) if (source[name] !== undefined) return source[name];
   return undefined;
}

/** Persist spotlight auction activity idempotently before advancing the indexer cursor. */
export async function processSpotlightBidEvents(events: IndexerChainEvent[]) {
   for (const event of events) {
      if (!TYPES.has(event.eventType)) continue;
      const payload = (event.payload && typeof event.payload === 'object'
         ? event.payload
         : event) as Record<string, any>;
      const keyId = String(field(payload, 'keyId', 'key_id', 'creatorId', 'creator_id') ?? '');
      const bidder = String(field(payload, 'bidder', 'wallet', 'actor') ?? '');
      const rawAmount = field(payload, 'amount', 'bid', 'winningBid', 'winning_bid');
      const amount = rawAmount === undefined ? '' : String(rawAmount);
      const txHash = String(event.txHash ?? '');
      const eventIndex = Number(event.eventIndex);
      const ledger = Number(event.ledger);
      if (!keyId || !bidder || !/^\d+(\.\d+)?$/.test(amount) || !txHash ||
         !Number.isSafeInteger(eventIndex) || eventIndex < 0 ||
         !Number.isSafeInteger(ledger) || ledger < 0) {
         throw new Error(`Malformed ${event.eventType} event`);
      }
      const timestamp = new Date(String(event.timestamp ?? event.ledgerClosedAt ?? Date.now()));
      if (!Number.isFinite(timestamp.getTime())) throw new Error('Invalid spotlight event timestamp');
      await prisma.$executeRaw(Prisma.sql`
         INSERT INTO "SpotlightBidEvent" ("id", "keyId", "bidder", "amount", "eventType", "txHash", "eventIndex", "ledger", "occurredAt")
         VALUES (${`${txHash}:${eventIndex}`}, ${keyId}, ${bidder}, ${amount}::decimal, ${event.eventType}, ${txHash}, ${eventIndex}, ${ledger}, ${timestamp})
         ON CONFLICT ("txHash", "eventIndex") DO NOTHING
      `);
      invalidateSpotlightCache();
   }
}

export async function getSpotlightBids(keyId: string, limit = 20, offset = 0) {
   return prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT "keyId", "bidder", "amount", "eventType", "txHash", "eventIndex", "ledger", "occurredAt"
      FROM "SpotlightBidEvent" WHERE "keyId" = ${keyId}
      ORDER BY "occurredAt" DESC, "ledger" DESC, "eventIndex" DESC
      LIMIT ${limit} OFFSET ${offset}
   `);
}

export async function getSpotlightBidTotals(keyId: string) {
   const rows = await prisma.$queryRaw<Array<{ total: string; bids: bigint }>>(Prisma.sql`
      SELECT COALESCE(SUM("amount"), 0)::text AS total, COUNT(*)::bigint AS bids
      FROM "SpotlightBidEvent" WHERE "keyId" = ${keyId}
   `);
   return { total: rows[0]?.total ?? '0', bids: Number(rows[0]?.bids ?? 0) };
}

export { TYPES as SPOTLIGHT_BID_EVENT_TYPES };
