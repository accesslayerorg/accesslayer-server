import { prisma } from '../../utils/prisma.utils';

export interface OrderCreatedEvent {
   orderId: string;
   wallet: string;
   keyId: string;
   side: string;
   lockedAmount: bigint;
   limitPrice: bigint;
   expiryLedger?: number;
   ledger: number;
}
export interface OrderFilledEvent {
   fillId: string;
   orderId: string;
   keeper: string;
   fillPrice: bigint;
   fillAmount: bigint;
   keeperReward: bigint;
   ledger: number;
}
export interface OrderCancelledEvent {
   orderId: string;
}
export interface OrderExpiryReclaimEvent {
   orderId: string;
}

export async function handleOrderCreated(event: OrderCreatedEvent) {
   // Idempotent on orderId — re-ingested creation events do nothing.
   await prisma.escrowOrder.upsert({
      where: { id: event.orderId },
      create: {
         id: event.orderId,
         wallet: event.wallet,
         keyId: event.keyId,
         side: event.side,
         lockedAmount: event.lockedAmount.toString(),
         limitPrice: event.limitPrice.toString(),
         status: 'open',
         expiryLedger: event.expiryLedger ?? null,
         createdLedger: event.ledger,
      },
      update: {},
   });
}

export async function handleOrderFilled(event: OrderFilledEvent) {
   // Idempotent on fillId — replayed fill events do not inflate keeper stats.
   await prisma.escrowFill.upsert({
      where: { id: event.fillId },
      create: {
         id: event.fillId,
         orderId: event.orderId,
         keeper: event.keeper,
         fillPrice: event.fillPrice.toString(),
         fillAmount: event.fillAmount.toString(),
         keeperReward: event.keeperReward.toString(),
         ledger: event.ledger,
      },
      update: {},
   });
   await prisma.escrowOrder.updateMany({
      where: { id: event.orderId, status: 'open' },
      data: { status: 'filled' },
   });
}

export async function handleOrderCancelled(event: OrderCancelledEvent) {
   await prisma.escrowOrder.updateMany({
      where: { id: event.orderId, status: 'open' },
      data: { status: 'cancelled' },
   });
}

export async function handleOrderExpiryReclaim(event: OrderExpiryReclaimEvent) {
   await prisma.escrowOrder.updateMany({
      where: { id: event.orderId, status: 'open' },
      data: { status: 'expired' },
   });
}

export async function listEscrowOrders(params: {
   wallet?: string;
   status?: string;
   cursor?: string;
   limit?: number;
}) {
   const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
   const where: any = {};
   if (params.wallet) where.wallet = params.wallet;
   if (params.status) where.status = params.status;
   const items = await prisma.escrowOrder.findMany({
      where,
      orderBy: { createdLedger: 'desc' },
      take: limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
   });
   const hasMore = items.length > limit;
   const page = items.slice(0, limit);
   return { items: page, nextCursor: hasMore ? page[page.length - 1].id : null };
}

export async function listFills(orderId: string) {
   return prisma.escrowFill.findMany({
      where: { orderId },
      orderBy: { ledger: 'asc' },
   });
}

export interface KeeperStats {
   keeper: string;
   fills: number;
   totalReward: string;
}

/**
 * Aggregate keeper stats (fills + total reward paid) across every fill. Used
 * by the keeper leaderboard — all values are strings so bigint totals are
 * preserved across the JSON boundary.
 */
export async function getKeeperStats(): Promise<KeeperStats[]> {
   const fills = await prisma.escrowFill.findMany({
      select: { keeper: true, keeperReward: true },
   });
   const totals = new Map<string, { fills: number; totalReward: bigint }>();
   for (const f of fills) {
      const prev = totals.get(f.keeper) ?? { fills: 0, totalReward: 0n };
      prev.fills += 1;
      prev.totalReward += BigInt(f.keeperReward);
      totals.set(f.keeper, prev);
   }
   return [...totals.entries()]
      .map(([keeper, v]) => ({
         keeper,
         fills: v.fills,
         totalReward: v.totalReward.toString(),
      }))
      .sort((a, b) =>
         BigInt(b.totalReward) - BigInt(a.totalReward) > 0n ? 1 : -1,
      );
}

/**
 * Reconcile off-chain order records with escrow state. An order diverges
 * when the off-chain record exists but the escrow row is absent or in a
 * contradictory status; the UI uses this to flag out-of-sync entries.
 */
export async function reconcileOrders(
   offchain: Array<{ id: string; status: string }>,
): Promise<Array<{ id: string; offchainStatus: string; onchainStatus: string | null }>> {
   if (offchain.length === 0) return [];
   const ids = offchain.map((o) => o.id);
   const rows = await prisma.escrowOrder.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true },
   });
   const byId = new Map(rows.map((r: { id: string; status: string }) => [r.id, r.status]));
   const diverged: Array<{ id: string; offchainStatus: string; onchainStatus: string | null }> = [];
   for (const o of offchain) {
      const onchain = byId.get(o.id) ?? null;
      if (onchain !== o.status) {
         diverged.push({ id: o.id, offchainStatus: o.status, onchainStatus: onchain });
      }
   }
   return diverged;
}
