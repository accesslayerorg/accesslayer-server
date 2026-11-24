// src/modules/notifications/notification.service.test.ts
const redisStore = new Map<string, string>();
const redisSets = new Map<string, Set<string>>();

jest.mock('../../utils/redis.utils', () => ({
   getRedis: () => ({
      get: jest.fn(async (key: string) => redisStore.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
         redisStore.set(key, value);
         return 'OK';
      }),
      smembers: jest.fn(async (key: string) => [
         ...(redisSets.get(key) ?? new Set()),
      ]),
      sadd: jest.fn(async (key: string, ...members: string[]) => {
         const set = redisSets.get(key) ?? new Set<string>();
         members.forEach(m => set.add(m));
         redisSets.set(key, set);
         return members.length;
      }),
      scard: jest.fn(async (key: string) => redisSets.get(key)?.size ?? 0),
      srem: jest.fn(async (key: string, member: string) => {
         redisSets.get(key)?.delete(member);
         return 1;
      }),
      del: jest.fn(async (key: string) => {
         redisStore.delete(key);
         redisSets.delete(key);
         return 1;
      }),
      expire: jest.fn(async () => 1),
   }),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      trade: { findMany: jest.fn() },
      keyOwnership: { findMany: jest.fn(), count: jest.fn() },
      creatorProfile: { findMany: jest.fn() },
      creatorPriceSnapshot: { findMany: jest.fn() },
      circuitBreakerTrip: { findMany: jest.fn() },
      priceAlert: { findMany: jest.fn() },
      vaultHealth: { findMany: jest.fn().mockResolvedValue([]) },
      collectionFollow: { findMany: jest.fn().mockResolvedValue([]) },
      collectionItem: { findMany: jest.fn().mockResolvedValue([]) },
      keyFreeze: { findMany: jest.fn().mockResolvedValue([]) },
      keyReport: { findMany: jest.fn().mockResolvedValue([]) },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import {
   listNotifications,
   markAllNotificationsRead,
} from './notification.service';
import { REDIS_KEYS } from '../../constants/notifications.constants';

describe('notification.service', () => {
   const wallet = 'GWALLET';
   const now = new Date('2026-08-26T12:00:00.000Z');

   beforeEach(() => {
      redisStore.clear();
      redisSets.clear();
      jest.clearAllMocks();
      (prisma.circuitBreakerTrip.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.priceAlert.findMany as jest.Mock).mockResolvedValue([]);
   });

   it('aggregates trade, lockup, and price_moved notifications newest first', async () => {
      (prisma.trade.findMany as jest.Mock).mockResolvedValue([
         {
            id: 't1',
            creatorId: 'key-a',
            quantity: '1',
            price: '100',
            txHash: 'hash',
            timestamp: new Date('2026-08-26T11:00:00.000Z'),
         },
      ]);
      (prisma.keyOwnership.findMany as jest.Mock).mockImplementation(
         ({ where }: { where: Record<string, unknown> }) => {
            if (where.ownerAddress === wallet && where.lockupExpiresAt) {
               return [
                  {
                     id: 'own-1',
                     creatorId: 'key-b',
                     balance: { toString: () => '2' },
                     lockupExpiresAt: new Date('2026-08-26T12:30:00.000Z'),
                  },
               ];
            }
            if (where.creatorId && (where.creatorId as { in?: string[] }).in) {
               return [{ creatorId: 'key-c' }];
            }
            return [];
         }
      );

      (prisma.creatorProfile.findMany as jest.Mock).mockResolvedValue([]);

      redisSets.set(REDIS_KEYS.priceMovedSet, new Set(['key-c']));
      (prisma.creatorPriceSnapshot.findMany as jest.Mock).mockResolvedValue([
         {
            creatorId: 'key-c',
            currentPrice: 1200n,
            price24hAgo: 1000n,
            updatedAt: new Date('2026-08-26T11:30:00.000Z'),
         },
      ]);
      (prisma.keyOwnership.count as jest.Mock).mockResolvedValue(1);

      const items = await listNotifications(wallet, now);

      expect(items.map(i => i.type)).toEqual([
         'lockup_expiring',
         'price_moved',
         'trade_completed',
      ]);
      expect(items.every(i => typeof i.read === 'boolean')).toBe(true);
   });

   it('markAllNotificationsRead stores a watermark used for read=true', async () => {
      (prisma.trade.findMany as jest.Mock).mockResolvedValue([
         {
            id: 't1',
            creatorId: 'key-a',
            quantity: '1',
            price: '100',
            txHash: 'hash',
            timestamp: new Date('2026-08-26T10:00:00.000Z'),
         },
      ]);
      (prisma.keyOwnership.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.creatorProfile.findMany as jest.Mock).mockResolvedValue([]);
      redisSets.set(REDIS_KEYS.priceMovedSet, new Set());

      await markAllNotificationsRead(wallet, now);
      const items = await listNotifications(wallet, now);
      expect(items[0]?.read).toBe(true);
   });

   it('creates one circuit_breaker_tripped notification per indexed trip', async () => {
      (prisma.trade.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.keyOwnership.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.creatorProfile.findMany as jest.Mock).mockResolvedValue([]);
      redisSets.set(REDIS_KEYS.priceMovedSet, new Set());
      (prisma.circuitBreakerTrip.findMany as jest.Mock).mockResolvedValue([
         {
            id: 'trip-1',
            keyId: 'key-a',
            actualBps: 3200,
            maxBps: 3000,
            txHash: 'tx-1',
            occurredAt: new Date('2026-08-26T11:45:00.000Z'),
         },
      ]);

      const items = await listNotifications(wallet, now);
      const trips = items.filter(
         item => item.type === 'circuit_breaker_tripped'
      );

      expect(trips).toHaveLength(1);
      expect(trips[0].id).toBe('circuit_breaker_tripped:trip-1');
      expect(trips[0].payload).toEqual(
         expect.objectContaining({
            keyId: 'key-a',
            actualBps: 3200,
            maxBps: 3000,
         })
      );
   });
   it('derives collection_item_added for keys added after the wallet followed (#1353)', async () => {
      (prisma.trade.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.keyOwnership.findMany as jest.Mock).mockResolvedValue([]);
      redisSets.set(REDIS_KEYS.priceMovedSet, new Set());
      (prisma.collectionFollow.findMany as jest.Mock).mockResolvedValueOnce([
         { collectionId: 'col-1', createdAt: new Date('2026-08-20T00:00:00.000Z') },
      ]);
      (prisma.collectionItem.findMany as jest.Mock).mockResolvedValueOnce([
         {
            keyId: 'key-a',
            note: 'Editor pick',
            createdAt: new Date('2026-08-26T10:00:00.000Z'),
            collectionId: 'col-1',
            collection: { slug: 'stellar-picks', title: 'Stellar picks' },
         },
      ]);
      (prisma.creatorProfile.findMany as jest.Mock).mockResolvedValue([{ id: 'key-a' }]);
      redisStore.set(
         REDIS_KEYS.notificationsReadAt(wallet),
         '2026-08-26T11:00:00.000Z'
      );

      const items = await listNotifications(wallet, now);
      const added = items.filter(item => item.type === 'collection_item_added');

      expect(added).toEqual([
         {
            id: 'collection_item_added:col-1:key-a',
            type: 'collection_item_added',
            createdAt: '2026-08-26T10:00:00.000Z',
            read: true,
            payload: {
               collectionSlug: 'stellar-picks',
               collectionTitle: 'Stellar picks',
               keyId: 'key-a',
               note: 'Editor pick',
            },
         },
      ]);
   });
});
