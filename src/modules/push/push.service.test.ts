const subscriptions = new Map<string, any>();

function matchWhere(row: any, where: any): boolean {
   if (where.wallet && row.wallet !== where.wallet) return false;
   if (where.endpoint && row.endpoint !== where.endpoint) return false;
   if (where.events?.has && !row.events.includes(where.events.has)) return false;
   return true;
}

const prismaMock: any = {
   pushSubscription: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
         const existing = subscriptions.get(where.endpoint);
         if (existing) {
            const next = { ...existing, ...update };
            subscriptions.set(where.endpoint, next);
            return next;
         }
         const row = {
            id: `sub_${subscriptions.size + 1}`,
            createdAt: new Date(),
            lastSuccessAt: null,
            ...create,
         };
         subscriptions.set(where.endpoint, row);
         return row;
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
         let count = 0;
         for (const [ep, row] of subscriptions.entries()) {
            if (matchWhere(row, where)) {
               subscriptions.delete(ep);
               count += 1;
            }
         }
         return { count };
      }),
      findMany: jest.fn(async ({ where }: any) => {
         return Array.from(subscriptions.values()).filter(r => matchWhere(r, where));
      }),
      update: jest.fn(async ({ where, data }: any) => {
         for (const [ep, row] of subscriptions.entries()) {
            if (row.id === where.id) {
               const next = { ...row, ...data };
               subscriptions.set(ep, next);
               return next;
            }
         }
         return null;
      }),
      delete: jest.fn(async ({ where }: any) => {
         for (const [ep, row] of subscriptions.entries()) {
            if (row.id === where.id) {
               subscriptions.delete(ep);
               return row;
            }
         }
         return null;
      }),
   },
};

jest.mock('../../utils/prisma.utils', () => ({ prisma: prismaMock }));
jest.mock('../../utils/logger.utils', () => ({
   logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config', () => ({
   envConfig: {
      VAPID_PUBLIC_KEY: 'test-vapid-pub',
      VAPID_PRIVATE_KEY: 'test-vapid-priv',
      VAPID_SUBJECT: 'mailto:test@accesslayer.org',
   },
}));

import {
   buildSanitizedPushPayload,
   PushService,
   resetPushSleepFn,
   setPushSleepFn,
   setWebPushClient,
} from './push.service';
import {
   getPushMetrics,
   resetPushMetrics,
} from '../../utils/push-metrics.utils';
import { emitOrderExecutable } from '../orders/order-events.utils';
import { emitGiftReceived, emitPriceAlert } from './push-events.utils';
import { startPushEventListeners, stopPushEventListeners } from './push.service';

describe('PushService (#1314)', () => {
   const sendNotification = jest.fn();
   const setVapidDetails = jest.fn();

   beforeEach(() => {
      subscriptions.clear();
      jest.clearAllMocks();
      resetPushMetrics();
      setPushSleepFn(async () => {});
      setWebPushClient({ sendNotification, setVapidDetails });
   });

   afterEach(() => {
      stopPushEventListeners();
      resetPushSleepFn();
      setWebPushClient(null);
   });

   it('delivers pushes only for events selected by the wallet and stops on unsubscribe', async () => {
      sendNotification.mockResolvedValue({ statusCode: 201 });

      await PushService.subscribe('GWALLET1', {
         endpoint: 'https://push.example/1',
         keys: { p256dh: 'p256dh-1', auth: 'auth-1' },
         events: ['order.executable'],
      });

      // Non-matching event is skipped
      const skipped = await PushService.send('GWALLET1', 'gift.received', {
         giftId: 'g1',
      });
      expect(skipped.sent).toBe(0);
      expect(sendNotification).not.toHaveBeenCalled();

      // Matching event is delivered
      const sent = await PushService.send('GWALLET1', 'order.executable', {
         orderId: 'ord-1',
         balance: '99999',
         email: 'secret@example.com',
      });
      expect(sent.sent).toBe(1);
      expect(sendNotification).toHaveBeenCalledTimes(1);

      const sentPayload = JSON.parse(sendNotification.mock.calls[0][1]);
      expect(sentPayload).toEqual({
         event: 'order.executable',
         deepLink: '/orders/ord-1',
      });
      expect(sentPayload.balance).toBeUndefined();
      expect(sentPayload.email).toBeUndefined();

      // Unsubscribe stops delivery immediately
      await PushService.unsubscribe('GWALLET1', 'https://push.example/1');
      const afterUnsub = await PushService.send('GWALLET1', 'order.executable', {
         orderId: 'ord-2',
      });
      expect(afterUnsub.sent).toBe(0);
      expect(sendNotification).toHaveBeenCalledTimes(1);
   });

   it('removes expired endpoints on 410 or 404 responses', async () => {
      await PushService.subscribe('GWALLET1', {
         endpoint: 'https://push.example/expired',
         keys: { p256dh: 'k1', auth: 'a1' },
         events: ['price.alert'],
      });

      sendNotification.mockRejectedValueOnce({ statusCode: 410 });
      const res = await PushService.send('GWALLET1', 'price.alert', { keyId: 'k-1' });
      expect(res.removed).toBe(1);
      expect(subscriptions.size).toBe(0);
      expect(getPushMetrics().push_expired_removed_total).toBe(1);
   });

   it('retries transient failures with backoff and increments failure metrics', async () => {
      const sleepDelays: number[] = [];
      setPushSleepFn(async ms => {
         sleepDelays.push(ms);
      });

      await PushService.subscribe('GWALLET1', {
         endpoint: 'https://push.example/flaky',
         keys: { p256dh: 'k1', auth: 'a1' },
         events: ['price.alert'],
      });

      sendNotification.mockRejectedValue({ statusCode: 503 });
      const res = await PushService.send('GWALLET1', 'price.alert', { keyId: 'k-1' });

      expect(res.failed).toBe(1);
      expect(sleepDelays).toEqual([1000, 2000]);
      expect(getPushMetrics().push_transient_failures_total).toBe(3);
      const stored = subscriptions.get('https://push.example/flaky');
      expect(stored.failureCount).toBe(1);
      expect(stored.nextRetryAt).toBeInstanceOf(Date);
   });

   it('strips balances and personal data from payloads', () => {
      expect(
         buildSanitizedPushPayload('gift.received', {
            giftId: 'g-9',
            balance: 1000,
            wallet: 'G123',
            email: 'a@b.com',
         })
      ).toEqual({
         event: 'gift.received',
         deepLink: '/gifts/g-9',
      });
   });

   it('subscribes to order.executable, gift.received, and price.alert on internal event bus', async () => {
      sendNotification.mockResolvedValue({ statusCode: 201 });
      await PushService.subscribe('GWALLET1', {
         endpoint: 'https://push.example/bus',
         keys: { p256dh: 'k1', auth: 'a1' },
         events: ['order.executable', 'gift.received', 'price.alert'],
      });

      startPushEventListeners();

      emitOrderExecutable({
         type: 'order.executable',
         orderId: 'o1',
         wallet: 'GWALLET1',
         keyId: 'k1',
         side: 'buy',
         targetPrice: '10',
         quantity: '5',
         currentPrice: '9',
         triggeredAt: new Date().toISOString(),
      });
      emitGiftReceived({ type: 'gift.received', wallet: 'GWALLET1', giftId: 'g1' });
      emitPriceAlert({ type: 'price.alert', wallet: 'GWALLET1', keyId: 'k1' });

      await new Promise(resolve => setTimeout(resolve, 20));
      expect(sendNotification).toHaveBeenCalledTimes(3);
   });
});
