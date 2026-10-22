import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

const TYPES = new Set(['ReserveAccrued', 'RESERVE_ACCRUED', 'ReserveDeployed', 'RESERVE_DEPLOYED']);
function pick(source: Record<string, any>, ...keys: string[]) {
   for (const key of keys) if (source[key] !== undefined) return source[key];
}

export async function processReserveEvents(events: IndexerChainEvent[]) {
   for (const event of events) {
      if (!TYPES.has(event.eventType)) continue;
      const payload = (event.payload && typeof event.payload === 'object' ? event.payload : event) as Record<string, any>;
      const asset = String(pick(payload, 'asset', 'assetId', 'asset_id', 'token') ?? '');
      const amountValue = pick(payload, 'amount', 'accrued', 'deployed');
      const amount = amountValue === undefined ? '' : String(amountValue);
      const balanceValue = pick(payload, 'reserveBalance', 'reserve_balance', 'balance');
      const reserveBalance = balanceValue === undefined ? null : String(balanceValue);
      const txHash = String(event.txHash ?? '');
      const eventIndex = Number(event.eventIndex);
      const ledger = Number(event.ledger);
      if (!asset || !/^\d+(\.\d+)?$/.test(amount) || (reserveBalance !== null && !/^\d+(\.\d+)?$/.test(reserveBalance)) || !txHash ||
         !Number.isSafeInteger(eventIndex) || eventIndex < 0 || !Number.isSafeInteger(ledger) || ledger < 0) {
         throw new Error(`Malformed ${event.eventType} event`);
      }
      const occurredAt = new Date(String(event.timestamp ?? event.ledgerClosedAt ?? Date.now()));
      if (!Number.isFinite(occurredAt.getTime())) throw new Error('Invalid reserve event timestamp');
      await prisma.$executeRaw(Prisma.sql`
         INSERT INTO "ReserveEvent" ("id", "asset", "eventType", "amount", "reserveBalance", "actor", "txHash", "eventIndex", "ledger", "occurredAt")
         VALUES (${`${txHash}:${eventIndex}`}, ${asset}, ${event.eventType}, ${amount}::decimal,
            ${reserveBalance}::decimal, ${pick(payload, 'actor', 'wallet') ?? null}, ${txHash}, ${eventIndex}, ${ledger}, ${occurredAt})
         ON CONFLICT ("txHash", "eventIndex") DO NOTHING
      `);
   }
}

export async function getReserveHistory(asset: string, limit = 50, offset = 0) {
   return prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT "asset", "eventType", "amount", "reserveBalance", "actor", "txHash", "eventIndex", "ledger", "occurredAt"
      FROM "ReserveEvent" WHERE "asset" = ${asset}
      ORDER BY "occurredAt" DESC, "ledger" DESC, "eventIndex" DESC
      LIMIT ${limit} OFFSET ${offset}
   `);
}

export async function getReserveBalance(asset: string) {
   const rows = await prisma.$queryRaw<Array<{ balance: string; accrued: string; deployed: string }>>(Prisma.sql`
      SELECT
         COALESCE(SUM(CASE WHEN "eventType" IN ('ReserveAccrued', 'RESERVE_ACCRUED') THEN "amount" ELSE 0 END), 0)::text AS accrued,
         COALESCE(SUM(CASE WHEN "eventType" IN ('ReserveDeployed', 'RESERVE_DEPLOYED') THEN "amount" ELSE 0 END), 0)::text AS deployed,
         COALESCE(SUM(CASE WHEN "eventType" IN ('ReserveAccrued', 'RESERVE_ACCRUED') THEN "amount" ELSE -"amount" END), 0)::text AS balance
      FROM "ReserveEvent" WHERE "asset" = ${asset}
   `);
   const row = rows[0] ?? { balance: '0', accrued: '0', deployed: '0' };
   const accrued = Number(row.accrued);
   const balance = Number(row.balance);
   return { ...row, lowReserve: accrued > 0 && balance < accrued * 0.1 };
}

export { TYPES as RESERVE_EVENT_TYPES };
