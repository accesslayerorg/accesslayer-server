import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import {
   ScheduledTransferQuery,
   scheduledTransferCursorSchema,
} from './scheduled-transfer.schemas';
import { readScheduledTransferLedger } from './scheduled-transfer-ledger.service';

export class ScheduledTransferCursorError extends Error {
   constructor() {
      super('Invalid scheduled transfer cursor');
      this.name = 'ScheduledTransferCursorError';
   }
}

function cursorFilter(address: string, query: ScheduledTransferQuery): Prisma.ScheduledTransferWhereInput | null {
   if (!query.cursor) return null;
   try {
      const cursor = scheduledTransferCursorSchema.parse(
         JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))
      );
      if (cursor.address !== address || cursor.direction !== query.direction) {
         throw new ScheduledTransferCursorError();
      }
      return {
         OR: [
            { scheduledLedger: { lt: cursor.ledger } },
            { scheduledLedger: cursor.ledger, id: { lt: cursor.id } },
         ],
      };
   } catch {
      throw new ScheduledTransferCursorError();
   }
}

function walletFilter(address: string, direction: ScheduledTransferQuery['direction']): Prisma.ScheduledTransferWhereInput {
   if (direction === 'incoming') return { recipient: address };
   if (direction === 'outgoing') return { sender: address };
   return { OR: [{ sender: address }, { recipient: address }] };
}

/** Exact amounts remain strings; claimability depends on the network ledger, not wall time. */
export async function listScheduledTransfers(address: string, query: ScheduledTransferQuery) {
   const wallet = walletFilter(address, query.direction);
   const after = cursorFilter(address, query);
   const rows = await prisma.scheduledTransfer.findMany({
      where: after ? { AND: [wallet, after] } : wallet,
      orderBy: [{ scheduledLedger: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
   });
   const ledger = await readScheduledTransferLedger();
   const page = rows.slice(0, query.limit);
   const items = page.map(row => {
      const estimatedMs = ledger.closeIntervalMs === null ? null :
         ledger.closedAt.getTime() + (row.releaseLedger - ledger.ledger) * ledger.closeIntervalMs;
      const estimate = estimatedMs === null ? null : new Date(estimatedMs);
      return {
         id: row.id, sender: row.sender, recipient: row.recipient,
         keyId: row.keyId, amount: row.amount, releaseLedger: row.releaseLedger,
         status: row.status,
         claimable: row.status === 'pending' && ledger.ledger >= row.releaseLedger,
         estimatedReleaseTime: estimate && Number.isFinite(estimate.getTime()) ?
            estimate.toISOString() : null,
         scheduledAt: row.scheduledAt.toISOString(),
         completedAt: row.completedAt?.toISOString() ?? null,
      };
   });
   const hasNextPage = rows.length > query.limit;
   const last = page[page.length - 1];
   const nextCursor = hasNextPage && last ? Buffer.from(JSON.stringify({
      version: 1, address, direction: query.direction,
      ledger: last.scheduledLedger, id: last.id,
   })).toString('base64url') : null;
   return { items, meta: { limit: query.limit, hasNextPage, nextCursor }, currentLedger: ledger.ledger };
}
