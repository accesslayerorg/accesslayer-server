
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
   if (!raw) return null;
   const parsed = new Date(raw);
   return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isRead(createdAt: Date, lastReadAt: Date | null): boolean {
   return lastReadAt !== null && createdAt.getTime() <= lastReadAt.getTime();
}

async function buildTradeCompleted(walletAddress: string, lastReadAt: Date | null): Promise<NotificationItem[]> {
   const trades = await prisma.trade.findMany({ where: { buyer: walletAddress }, orderBy: { timestamp: 'desc' }, take: 50 });
   return trades.map((trade: { id: string; timestamp: Date; creatorId: string; quantity: unknown; price: unknown; txHash: string | null }) => ({
      id: "trade_completed:${trade.id}",
      type: NOTIFICATION_TYPES.TRADE_COMPLETED,
      createdAt: trade.timestamp.toISOString(),
      read: isRead(trade.timestamp, lastReadAt),
      payload: { tradeId: trade.id, keyId: trade.creatorId, quantity: trade.quantity, price: trade.price, txHash: trade.txHash },
   }));
}

async function buildLockupExpiring(walletAddress: string, lastReadAt: Date | null, now: Date): Promise<NotificationItem[]> {
   const windowEnd = new Date(now.getTime() + LOCKUP_WARNING_WINDOW_MS);
   const holdings = await prisma.keyOwnership.findMany({ where: { ownerAddress: walletAddress, balance: { gt: 0 }, lockupExpiresAt: { gt: now, lte: windowEnd } } });
   return holdings.map((holding: { id: string; creatorId: string; lockupExpiresAt: Date | null; balance: { toString(): string } }) => ({
      id: "lockup_expiring:${holding.id}",
      type: NOTIFICATION_TYPES.LOCKUP_EXPIRING,
      createdAt: holding.lockupExpiresAt!.toISOString(),
      read: isRead(holding.lockupExpiresAt!, lastReadAt),
      payload: { keyId: holding.creatorId, lockupExpiresAt: holding.lockupExpiresAt!.toISOString(), balance: holding.balance.toString() },
   }));
}

async function buildKeyDeprecated(walletAddress: string, lastReadAt: Date | null): Promise<NotificationItem[]> {
   const holdings = await prisma.keyOwnership.findMany({ where: { ownerAddress: walletAddress, balance: { gt: 0 } }, select: { creatorId: true } });
   if (holdings.length === 0) return [];
   const keyIds = holdings.map((h: { creatorId: string }) => h.creatorId);
   const deprecatedKeys = await prisma.creatorProfile.findMany({ where: { id: { in: keyIds }, deprecatedAt: { not: null } }, select: { id: true, deprecatedAt: true, buybackPriceXlm: true, buybackExpiresAt: true } });
   return deprecatedKeys.map((key) => ({
      id: "key_deprecated:${key.id}",
      type: NOTIFICATION_TYPES.KEY_DEPRECATED,
      createdAt: key.deprecatedAt!.toISOString(),
      read: isRead(key.deprecatedAt!, lastReadAt),
      payload: { keyId: key.id, buybackPriceXlm: key.buybackPriceXlm != null ? String(key.buybackPriceXlm) : null, buybackExpiresAt: key.buybackExpiresAt ? key.buybackExpiresAt.toISOString() : null },
   }));
}

export async function buildKeySunsetFlagged(walletAddress: string, lastReadAt: Date | null): Promise<NotificationItem[]> {
   const holdings = await prisma.keyOwnership.findMany({ where: { ownerAddress: walletAddress, balance: { gt: 0 } }, select: { creatorId: true } });
   if (holdings.length === 0) return [];
   const keyIds = holdings.map((h: { creatorId: string }) => h.creatorId);
   const sunsetKeys = await prisma.creatorProfile.findMany({ where: { id: { in: keyIds }, deprecatedAt: { not: null } }, select: { id: true, deprecatedAt: true, buybackPriceXlm: true, buybackExpiresAt: true } });
   return sunsetKeys.map((key) => ({
      id: "key_sunset_flagged:${key.id}",
      type: NOTIFICATION_TYPES.KEY_SUNSET_FLAGGED,
      createdAt: key.deprecatedAt!.toISOString(),
      read: isRead(key.deprecatedAt!, lastReadAt),
      payload: { keyId: key.id, sunsetDeadline: key.buybackExpiresAt ? key.buybackExpiresAt.toISOString() : null, buybackPriceXlm: key.buybackPriceXlm != null ? String(key.buybackPriceXlm) : null },
   }));
}

async function buildPriceMoved(walletAddress: string, lastReadAt: Date | null, now: Date): Promise<NotificationItem[]> {
   const flaggedKeyIds = await getPriceMovedKeyIds();
   if (flaggedKeyIds.length === 0) return [];
   const holdings = await prisma.keyOwnership.findMany({ where: { ownerAddress: walletAddress, balance: { gt: 0 }, creatorId: { in: flaggedKeyIds } }, select: { creatorId: true } });
   if (holdings.length === 0) return [];
   const heldFlaggedIds = holdings.map((h: { creatorId: string }) => h.creatorId);
   const snapshots = await prisma.creatorPriceSnapshot.findMany({ where: { creatorId: { in: heldFlaggedIds } }, select: { creatorId: true, currentPrice: true, price24hAgo: true, updatedAt: true } });
   const notifications: NotificationItem[] = [];
   for (const snapshot of snapshots) {
      notifications.push({
         id: "price_moved:${snapshot.creatorId}",
         type: NOTIFICATION_TYPES.PRICE_MOVED,
         createdAt: (snapshot.updatedAt ?? now).toISOString(),
         read: isRead(snapshot.updatedAt ?? now, lastReadAt),
         payload: { keyId: snapshot.creatorId, currentPrice: snapshot.currentPrice.toString(), price24hAgo: snapshot.price24hAgo.toString() },
      });
      await markPriceMovedDelivered(snapshot.creatorId, walletAddress);
   }
   return notifications;
}

async function buildPriceAlertTriggered(walletAddress: string, lastReadAt: Date | null): Promise<NotificationItem[]> {
   const triggeredAlerts = await prisma.priceAlert.findMany({ where: { walletAddress, triggeredAt: { not: null } }, orderBy: { triggeredAt: 'desc' }, take: 50 });
   if (triggeredAlerts.length === 0) return [];
   const creatorIds = Array.from(new Set(triggeredAlerts.map((a: { creatorId: string }) => a.creatorId)));
   const snapshots = await prisma.creatorPriceSnapshot.findMany({ where: { creatorId: { in: creatorIds } }, select: { creatorId: true, currentPrice: true } });
   const priceByCreator = new Map<string, string>(snapshots.map((s: { creatorId: string; currentPrice: unknown }) => [s.creatorId, String(s.currentPrice)]));
   return triggeredAlerts.map((alert: { id: string; creatorId: string; targetPrice: unknown; direction: string; triggeredAt: Date | null }) => ({
      id: "price_alert_triggered:${alert.id}",
      type: NOTIFICATION_TYPES.PRICE_ALERT_TRIGGERED,
      createdAt: alert.triggeredAt!.toISOString(),
      read: isRead(alert.triggeredAt!, lastReadAt),
      payload: { alertId: alert.id, keyId: alert.creatorId, targetPrice: String(alert.targetPrice), triggeredPrice: priceByCreator.get(alert.creatorId) ?? null, direction: alert.direction },
   }));
}


export async function listNotifications(walletAddress: string, now: Date = new Date()): Promise<NotificationItem[]> {
   const lastReadAt = await getLastReadAt(walletAddress);
   const [trades, lockups, priceMoved, keyDeprecated, priceAlertTriggered] = await Promise.all([
      buildTradeCompleted(walletAddress, lastReadAt),
      buildLockupExpiring(walletAddress, lastReadAt, now),
      buildPriceMoved(walletAddress, lastReadAt, now),
      buildKeyDeprecated(walletAddress, lastReadAt),
      buildPriceAlertTriggered(walletAddress, lastReadAt),
   ]);
   return [...trades, ...lockups, ...priceMoved, ...keyDeprecated, ...priceAlertTriggered].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function markAllNotificationsRead(walletAddress: string, now: Date = new Date()): Promise<void> {
   const redis = getRedis();
   if (!redis) return;
   await redis.set(REDIS_KEYS.notificationsReadAt(walletAddress), now.toISOString());
}
