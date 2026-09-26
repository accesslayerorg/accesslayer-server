// src/modules/notifications/notification.service.ts
import { prisma } from '../../utils/prisma.utils';
import { getRedis } from '../../utils/redis.utils';
import {
   LOCKUP_WARNING_WINDOW_MS,
   NOTIFICATION_TYPES,
   REDIS_KEYS,
} from '../../constants/notifications.constants';
import {
   getPriceMovedKeyIds,
   markPriceMovedDelivered,
} from '../keys/price-moved.redis';
import { NotificationItem } from './notification.types';

async function getLastReadAt(walletAddress: string): Promise<Date | null> {
   const redis = getRedis();
   if (!redis) return null;
   const raw = await redis.get(REDIS_KEYS.notificationsReadAt(walletAddress));
   if (!raw) {
      return null;
   }
   const parsed = new Date(raw);
   return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isRead(createdAt: Date, lastReadAt: Date | null): boolean {
   return lastReadAt !== null && createdAt.getTime() <= lastReadAt.getTime();
}

async function buildTradeCompleted(
   walletAddress: string,
   lastReadAt: Date | null
): Promise<NotificationItem[]> {
   const trades = await prisma.trade.findMany({
      where: { buyer: walletAddress },
      orderBy: { timestamp: 'desc' },
      take: 50,
   });

   return trades.map(
      (trade: {
         id: string;
         timestamp: Date;
         creatorId: string;
         quantity: unknown;
         price: unknown;
         txHash: string | null;
      }) => {
         const createdAt = trade.timestamp;
         return {
            id: `trade_completed:${trade.id}`,
            type: NOTIFICATION_TYPES.TRADE_COMPLETED,
            createdAt: createdAt.toISOString(),
            read: isRead(createdAt, lastReadAt),
            payload: {
               tradeId: trade.id,
               keyId: trade.creatorId,
               quantity: trade.quantity,
               price: trade.price,
               txHash: trade.txHash,
            },
         };
      }
   );
}

async function buildLockupExpiring(
   walletAddress: string,
   lastReadAt: Date | null,
   now: Date
): Promise<NotificationItem[]> {
   const windowEnd = new Date(now.getTime() + LOCKUP_WARNING_WINDOW_MS);
   const holdings = await prisma.keyOwnership.findMany({
      where: {
         ownerAddress: walletAddress,
         balance: { gt: 0 },
         lockupExpiresAt: {
            gt: now,
            lte: windowEnd,
         },
      },
   });

   return holdings.map(
      (holding: {
         id: string;
         creatorId: string;
         lockupExpiresAt: Date | null;
         balance: { toString(): string };
      }) => {
         const createdAt = holding.lockupExpiresAt!;
         return {
            id: `lockup_expiring:${holding.id}`,
            type: NOTIFICATION_TYPES.LOCKUP_EXPIRING,
            createdAt: createdAt.toISOString(),
            read: isRead(createdAt, lastReadAt),
            payload: {
               keyId: holding.creatorId,
               lockupExpiresAt: holding.lockupExpiresAt!.toISOString(),
               balance: holding.balance.toString(),
            },
         };
      }
   );
}

async function buildKeyDeprecated(
   walletAddress: string,
   lastReadAt: Date | null
): Promise<NotificationItem[]> {
   const holdings = await prisma.keyOwnership.findMany({
      where: { ownerAddress: walletAddress, balance: { gt: 0 } },
      select: { creatorId: true },
   });
   if (holdings.length === 0) {
      return [];
   }

   const keyIds = holdings.map((h: { creatorId: string }) => h.creatorId);
   const deprecatedKeys = await prisma.creatorProfile.findMany({
      where: { id: { in: keyIds }, deprecatedAt: { not: null } },
      select: {
         id: true,
         deprecatedAt: true,
         buybackPriceXlm: true,
         buybackExpiresAt: true,
      },
   });

   return deprecatedKeys.map(key => {
      // deprecatedAt is guaranteed non-null by the where: { not: null } filter above
      const createdAt = key.deprecatedAt!;
      return {
         id: `key_deprecated:${key.id}`,
         type: NOTIFICATION_TYPES.KEY_DEPRECATED,
         createdAt: createdAt.toISOString(),
         read: isRead(createdAt, lastReadAt),
         payload: {
            keyId: key.id,
            buybackPriceXlm:
               key.buybackPriceXlm !== null && key.buybackPriceXlm !== undefined
                  ? String(key.buybackPriceXlm)
                  : null,
            buybackExpiresAt: key.buybackExpiresAt
               ? key.buybackExpiresAt.toISOString()
               : null,
         },
      };
   });
}

async function buildPriceMoved(
   walletAddress: string,
   lastReadAt: Date | null,
   now: Date
): Promise<NotificationItem[]> {
   const flaggedKeyIds = await getPriceMovedKeyIds();
   if (flaggedKeyIds.length === 0) {
      return [];
   }

   const holdings = await prisma.keyOwnership.findMany({
      where: {
         ownerAddress: walletAddress,
         balance: { gt: 0 },
         creatorId: { in: flaggedKeyIds },
      },
      select: { creatorId: true },
   });

   if (holdings.length === 0) {
      return [];
   }

   const heldFlaggedIds = holdings.map(
      (h: { creatorId: string }) => h.creatorId
   );
   const snapshots = await prisma.creatorPriceSnapshot.findMany({
      where: { creatorId: { in: heldFlaggedIds } },
      select: {
         creatorId: true,
         currentPrice: true,
         price24hAgo: true,
         updatedAt: true,
      },
   });

   const notifications: NotificationItem[] = [];
   for (const snapshot of snapshots) {
      const createdAt = snapshot.updatedAt ?? now;
      notifications.push({
         id: `price_moved:${snapshot.creatorId}`,
         type: NOTIFICATION_TYPES.PRICE_MOVED,
         createdAt: createdAt.toISOString(),
         read: isRead(createdAt, lastReadAt),
         payload: {
            keyId: snapshot.creatorId,
            currentPrice: snapshot.currentPrice.toString(),
            price24hAgo: snapshot.price24hAgo.toString(),
         },
      });
      await markPriceMovedDelivered(snapshot.creatorId, walletAddress);
   }

   return notifications;
}

export async function listNotifications(
   walletAddress: string,
   now: Date = new Date()
): Promise<NotificationItem[]> {
   const lastReadAt = await getLastReadAt(walletAddress);

   const [trades, lockups, priceMoved, keyDeprecated] = await Promise.all([
      buildTradeCompleted(walletAddress, lastReadAt),
      buildLockupExpiring(walletAddress, lastReadAt, now),
      buildPriceMoved(walletAddress, lastReadAt, now),
      buildKeyDeprecated(walletAddress, lastReadAt),
   ]);

   return [...trades, ...lockups, ...priceMoved, ...keyDeprecated].sort(
      (a, b) =>
         new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
   );
}

export async function markAllNotificationsRead(
   walletAddress: string,
   now: Date = new Date()
): Promise<void> {
   const redis = getRedis();
   if (!redis) return;
   await redis.set(
      REDIS_KEYS.notificationsReadAt(walletAddress),
      now.toISOString()
   );
}
