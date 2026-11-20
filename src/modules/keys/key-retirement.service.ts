import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';

export const KEY_RETIREMENT_CACHE_TTL_SECONDS = 60;
export const keyRetirementCacheKey = (keyId: string) =>
   `keys:retirement:${keyId}`;

type RetirementRow = {
   eventType: string;
   status: string;
   buybackPrice: unknown;
   noticeExpiry: Date | string | null;
   reason: string | null;
   occurredAt: Date | string;
   txHash: string;
   eventIndex: number;
   ledger: number;
};

async function getRows(keyId: string): Promise<RetirementRow[]> {
   const cacheKey = keyRetirementCacheKey(keyId);
   const cached = await cacheGetJson<RetirementRow[]>(cacheKey);
   if (cached) return cached;
   const rows = (await prisma.keyRetirement.findMany({
      where: { keyId },
      orderBy: [{ occurredAt: 'asc' }, { eventIndex: 'asc' }],
      select: {
         eventType: true,
         status: true,
         buybackPrice: true,
         noticeExpiry: true,
         reason: true,
         occurredAt: true,
         txHash: true,
         eventIndex: true,
         ledger: true,
      },
   })) as RetirementRow[];
   await cacheSetJson(cacheKey, rows, KEY_RETIREMENT_CACHE_TTL_SECONDS);
   return rows;
}

export async function getKeyRetirement(keyId: string, now = new Date()) {
   const rows = await getRows(keyId);
   if (rows.length === 0) {
      return {
         key_id: keyId,
         status: 'none',
         buyback_price: null,
         notice_expiry: null,
         notice_seconds_remaining: 0,
         reason: null,
      };
   }
   const state = rows.reduce(
      (current, row) => ({
         status: row.status,
         buybackPrice: row.buybackPrice ?? current.buybackPrice,
         noticeExpiry: row.noticeExpiry ?? current.noticeExpiry,
         reason: row.reason ?? current.reason,
      }),
      {
         status: 'none',
         buybackPrice: null as unknown,
         noticeExpiry: null as Date | string | null,
         reason: null as string | null,
      }
   );
   const expiry = state.noticeExpiry ? new Date(state.noticeExpiry) : null;
   return {
      key_id: keyId,
      status: state.status,
      buyback_price:
         state.buybackPrice == null ? null : String(state.buybackPrice),
      notice_expiry: expiry?.toISOString() ?? null,
      notice_seconds_remaining: expiry
         ? Math.max(0, Math.ceil((expiry.getTime() - now.getTime()) / 1000))
         : 0,
      reason: state.reason,
   };
}

export async function getKeyRetirementHistory(keyId: string) {
   const rows = await getRows(keyId);
   return [...rows].reverse().map(row => ({
      event_type: row.eventType,
      status: row.status,
      buyback_price: row.buybackPrice == null ? null : String(row.buybackPrice),
      notice_expiry: row.noticeExpiry
         ? new Date(row.noticeExpiry).toISOString()
         : null,
      reason: row.reason,
      occurred_at: new Date(row.occurredAt).toISOString(),
      tx_hash: row.txHash,
      event_index: row.eventIndex,
      ledger: row.ledger,
   }));
}
