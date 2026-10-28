import { prisma } from '../../utils/prisma.utils';
import { ActivityQueryType } from './activity.schemas';
import { truncateWallet } from '../../utils/wallet-display.utils';

export interface FormattedActivityItem {
   id: string;
   type: string;
   actor: string;
   wallet: string;
   action: string;
   creator_wallet: string | null;
   creatorId: string | null;
   key_amount: number;
   target: string | null;
   payload: any;
   createdAt: Date | string;
   created_at: string;
}

export function mapActivityItem(item: any): FormattedActivityItem {
   const payload = item.payload || {};
   const action =
      payload.action ||
      (item.type === 'KEY_BOUGHT'
         ? 'buy'
         : item.type === 'KEY_SOLD'
           ? 'sell'
           : String(item.type));

   const wallet =
      payload.wallet || (item.actor ? truncateWallet(item.actor) : '');

   const creator_wallet = payload.creator_wallet || item.creatorId || null;

   const key_amount =
      typeof payload.key_amount === 'number'
         ? payload.key_amount
         : typeof payload.amount === 'number'
           ? payload.amount
           : Number(payload.key_amount || payload.amount || 0);

   const created_at =
      item.createdAt instanceof Date
         ? item.createdAt.toISOString()
         : String(item.createdAt || '');

   return {
      ...item,
      wallet,
      action,
      creator_wallet,
      key_amount,
      created_at,
   };
}

export async function fetchActivityFeed(
   query: ActivityQueryType
): Promise<[FormattedActivityItem[], number]> {
   const { limit, offset, creatorId, actor, type } = query;

   const where: any = {};
   if (creatorId) where.creatorId = creatorId;
   if (actor) where.actor = actor;
   if (type) {
      where.type = type;
   } else {
      where.type = { in: ['KEY_BOUGHT', 'KEY_SOLD'] };
   }

   const [items, total] = await Promise.all([
      prisma.activity.findMany({
         where,
         orderBy: { createdAt: 'desc' },
         skip: offset,
         take: limit,
      }),
      prisma.activity.count({ where }),
   ]);

   const mappedItems = items.map(mapActivityItem);

   return [mappedItems, total];
}
