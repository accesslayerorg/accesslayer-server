import { prisma } from '../../utils/prisma.utils';
import { decodeCursor, encodeCursor } from '../../utils/cursor.utils';

export const GOVERNANCE_EVENT_TYPES = [
   'admin_proposed',
   'admin_accepted',
   'admin_transfer_cancelled',
   'ceiling_raised',
   'fee_schedule_changed',
] as const;

export type GovernanceEventType = (typeof GOVERNANCE_EVENT_TYPES)[number];

export interface IndexedGovernanceEvent {
   type: GovernanceEventType;
   actor: string;
   target?: string;
   payload: Record<string, unknown>;
   ledger?: number;
   txHash: string;
   eventIndex: number;
}

export async function indexGovernanceEvent(event: IndexedGovernanceEvent) {
   return prisma.governanceEvent.upsert({
      where: { txHash_eventIndex: { txHash: event.txHash, eventIndex: event.eventIndex } },
      create: event,
      update: {},
   });
}

export async function listGovernanceEvents(type?: string, cursor?: string) {
   const after = cursor ? decodeCursor<{ createdAt: string; id: string }>(cursor) : undefined;
   const rows = await prisma.governanceEvent.findMany({
      where: {
         ...(type ? { type } : {}),
         ...(after ? { OR: [{ createdAt: { lt: new Date(after.createdAt) } }, { createdAt: new Date(after.createdAt), id: { lt: after.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
   });
   const items = rows.slice(0, 50);
   const last = items.at(-1);
   return {
      items,
      next: rows.length > 50 && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null,
   };
}

export async function getCurrentAdmin() {
   const [accepted, pending] = await Promise.all([
      prisma.governanceEvent.findFirst({ where: { type: 'admin_accepted' }, orderBy: { ledger: 'desc' } }),
      prisma.governanceEvent.findFirst({ where: { type: 'admin_proposed' }, orderBy: { ledger: 'desc' } }),
   ]);
   return {
      currentAdmin: accepted?.actor ?? null,
      pendingAdmin: pending?.target ?? null,
      pendingExpiresAt: (pending?.payload as { expiresAt?: string } | null)?.expiresAt ?? null,
   };
}
