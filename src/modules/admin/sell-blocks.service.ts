import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { SellBlocksQuery, SellBlocksSummaryQuery } from './sell-blocks.schemas';

export interface SellBlockSummaryKey {
   keyId: string;
   count: number;
}

export interface SellBlockSummaryWallet {
   wallet: string;
   count: number;
   keys: SellBlockSummaryKey[];
}

export interface SellBlocksSummary {
   window: string;
   since: string;
   totalBlocks: number;
   wallets: SellBlockSummaryWallet[];
   keys: SellBlockSummaryKey[];
}

function getWindowStart(window: string, now: Date): Date {
   const amount = Number.parseInt(window, 10);
   const hours = window.endsWith('d') ? amount * 24 : amount;
   return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

export async function getSellBlocks(query: SellBlocksQuery) {
   const where: Prisma.SellBlockWhereInput = {
      ...(query.wallet ? { wallet: query.wallet } : {}),
      ...(query.keyId ? { keyId: query.keyId } : {}),
   };
   const rows = await prisma.sellBlock.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      skip: query.cursor ? 1 : 0,
      cursor: query.cursor ? { id: query.cursor } : undefined,
   });
   const hasMore = rows.length > query.limit;
   const blocks = rows.slice(0, query.limit);

   return {
      blocks,
      pagination: {
         limit: query.limit,
         hasMore,
         nextCursor: hasMore ? blocks[blocks.length - 1]?.id : undefined,
      },
   };
}

export async function getSellBlocksSummary(
   query: SellBlocksSummaryQuery,
   now = new Date()
): Promise<SellBlocksSummary> {
   const since = getWindowStart(query.window, now);
   const where: Prisma.SellBlockWhereInput = { createdAt: { gte: since } };
   const [walletGroups, walletKeyGroups, keyGroups] = await Promise.all([
      prisma.sellBlock.groupBy({
         by: ['wallet'],
         where,
         _count: { _all: true },
         orderBy: [{ _count: { wallet: 'desc' } }, { wallet: 'asc' }],
      }),
      prisma.sellBlock.groupBy({
         by: ['wallet', 'keyId'],
         where,
         _count: { _all: true },
         orderBy: [
            { wallet: 'asc' },
            { _count: { keyId: 'desc' } },
            { keyId: 'asc' },
         ],
      }),
      prisma.sellBlock.groupBy({
         by: ['keyId'],
         where,
         _count: { _all: true },
         orderBy: [{ _count: { keyId: 'desc' } }, { keyId: 'asc' }],
      }),
   ]);

   const keysByWallet = new Map<string, SellBlockSummaryKey[]>();
   for (const group of walletKeyGroups) {
      const keys = keysByWallet.get(group.wallet) ?? [];
      keys.push({ keyId: group.keyId, count: group._count._all });
      keysByWallet.set(group.wallet, keys);
   }

   const wallets = walletGroups.map(group => ({
      wallet: group.wallet,
      count: group._count._all,
      keys: keysByWallet.get(group.wallet) ?? [],
   }));
   const keys = keyGroups.map(group => ({
      keyId: group.keyId,
      count: group._count._all,
   }));

   return {
      window: query.window,
      since: since.toISOString(),
      totalBlocks: wallets.reduce((total, wallet) => total + wallet.count, 0),
      wallets,
      keys,
   };
}
