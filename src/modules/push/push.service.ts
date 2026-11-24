import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { envConfig } from '../../config';
import {
   incrementPushExpiredRemoved,
   incrementPushSent,
   incrementPushTransientFailure,
} from '../../utils/push-metrics.utils';
import { onOrderExecutable } from '../orders/order-events.utils';
import {
   onGiftReceived,
   onPriceAlert,
   PushEventType,
} from './push-events.utils';

export interface WebPushSubscriptionInput {
   endpoint: string;
   keys: {
      p256dh: string;
      auth: string;
   };
}

export interface WebPushClient {
   setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
   sendNotification(
      subscription: WebPushSubscriptionInput,
      payload: string
   ): Promise<unknown>;
}

export interface VapidConfig {
   subject: string;
   publicKey: string;
   privateKey: string;
}

export interface SanitizedPushPayload {
   event: PushEventType;
   deepLink: string;
}

const DEFAULT_MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 1000;
const PERSISTENT_BACKOFF_BASE_MS = 30_000;
const PERSISTENT_BACKOFF_MAX_MS = 3_600_000;

let customWebPushClient: WebPushClient | null = null;
let customVapidLoader: (() => VapidConfig | null) | null = null;
let sleepFn: (ms: number) => Promise<void> = ms =>
   new Promise(resolve => setTimeout(resolve, ms));

export function setWebPushClient(client: WebPushClient | null): void {
   customWebPushClient = client;
}

export function setVapidConfigLoader(loader: (() => VapidConfig | null) | null): void {
   customVapidLoader = loader;
}

export function setPushSleepFn(fn: (ms: number) => Promise<void>): void {
   sleepFn = fn;
}

export function resetPushSleepFn(): void {
   sleepFn = ms => new Promise(resolve => setTimeout(resolve, ms));
}

export function getVapidConfig(): VapidConfig | null {
   if (customVapidLoader) {
      return customVapidLoader();
   }
   const cfg = envConfig as unknown as Record<string, string | undefined>;
   const publicKey = cfg.VAPID_PUBLIC_KEY;
   const privateKey = cfg.VAPID_PRIVATE_KEY;
   const subject = cfg.VAPID_SUBJECT ?? 'mailto:notifications@accesslayer.org';
   if (!publicKey || !privateKey) {
      return null;
   }
   return { subject, publicKey, privateKey };
}

function resolveWebPushClient(): WebPushClient {
   if (customWebPushClient) {
      return customWebPushClient;
   }
   // Load web-push dynamically so environments without the optional package
   // still compile cleanly and can inject a mock in tests.
   // eslint-disable-next-line @typescript-eslint/no-require-imports
   return require('web-push') as WebPushClient;
}

/**
 * Strips all balances, amounts, prices, and personal data.
 * Only the event type and a deep link are included in push payloads.
 */
export function buildSanitizedPushPayload(
   event: PushEventType,
   payload: Record<string, unknown> = {}
): SanitizedPushPayload {
   let deepLink = typeof payload.deepLink === 'string' && payload.deepLink.startsWith('/')
      ? payload.deepLink
      : '';

   if (!deepLink) {
      if (event === 'order.executable') {
         deepLink = payload.orderId
            ? `/orders/${String(payload.orderId)}`
            : '/orders';
      } else if (event === 'gift.received') {
         deepLink = payload.giftId
            ? `/gifts/${String(payload.giftId)}`
            : '/gifts';
      } else {
         deepLink = payload.keyId
            ? `/keys/${String(payload.keyId)}`
            : '/keys';
      }
   }

   return { event, deepLink };
}

function extractHttpStatus(error: unknown): number | undefined {
   if (!error || typeof error !== 'object') return undefined;
   const err = error as Record<string, unknown>;
   if (typeof err.statusCode === 'number') return err.statusCode;
   if (typeof err.status === 'number') return err.status;
   return undefined;
}

export class PushService {
   static async subscribe(
      wallet: string,
      input: {
         endpoint: string;
         keys: { p256dh: string; auth: string };
         events: PushEventType[];
      }
   ) {
      return prisma.pushSubscription.upsert({
         where: { endpoint: input.endpoint },
         create: {
            wallet,
            endpoint: input.endpoint,
            keys: input.keys as unknown as object,
            events: input.events,
            failureCount: 0,
            nextRetryAt: null,
         },
         update: {
            wallet,
            keys: input.keys as unknown as object,
            events: input.events,
            failureCount: 0,
            nextRetryAt: null,
         },
      });
   }

   static async unsubscribe(wallet: string, endpoint: string): Promise<boolean> {
      const res = await prisma.pushSubscription.deleteMany({
         where: { wallet, endpoint },
      });
      return res.count > 0;
   }

   static async send(
      wallet: string,
      event: PushEventType,
      payload: Record<string, unknown> = {}
   ): Promise<{ sent: number; removed: number; failed: number }> {
      const vapid = getVapidConfig();
      if (!vapid) {
         logger.warn('VAPID keys not configured; skipping web push delivery');
         return { sent: 0, removed: 0, failed: 0 };
      }

      const now = new Date();
      const subscriptions = await prisma.pushSubscription.findMany({
         where: {
            wallet,
            events: { has: event },
            OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
         },
      });

      if (subscriptions.length === 0) {
         return { sent: 0, removed: 0, failed: 0 };
      }

      const client = resolveWebPushClient();
      client.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

      const sanitized = JSON.stringify(buildSanitizedPushPayload(event, payload));
      let sent = 0;
      let removed = 0;
      let failed = 0;

      for (const sub of subscriptions) {
         const keys = sub.keys as { p256dh: string; auth: string };
         let delivered = false;
         let expired = false;

         for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
            try {
               await client.sendNotification(
                  { endpoint: sub.endpoint, keys },
                  sanitized
               );
               delivered = true;
               break;
            } catch (error) {
               const status = extractHttpStatus(error);
               if (status === 404 || status === 410) {
                  expired = true;
                  break;
               }

               incrementPushTransientFailure();
               if (attempt < DEFAULT_MAX_RETRIES) {
                  await sleepFn(BASE_BACKOFF_MS * Math.pow(2, attempt));
               }
            }
         }

         if (delivered) {
            sent += 1;
            incrementPushSent();
            await prisma.pushSubscription.update({
               where: { id: sub.id },
               data: {
                  lastSuccessAt: new Date(),
                  failureCount: 0,
                  nextRetryAt: null,
               },
            });
         } else if (expired) {
            removed += 1;
            incrementPushExpiredRemoved();
            await prisma.pushSubscription.delete({
               where: { id: sub.id },
            });
         } else {
            failed += 1;
            const nextFailures = (sub.failureCount ?? 0) + 1;
            const backoffMs = Math.min(
               PERSISTENT_BACKOFF_MAX_MS,
               PERSISTENT_BACKOFF_BASE_MS * Math.pow(2, nextFailures - 1)
            );
            await prisma.pushSubscription.update({
               where: { id: sub.id },
               data: {
                  failureCount: nextFailures,
                  nextRetryAt: new Date(Date.now() + backoffMs),
               },
            });
         }
      }

      return { sent, removed, failed };
   }
}

let unsubscribers: Array<() => void> = [];

export function startPushEventListeners(): void {
   if (unsubscribers.length > 0) {
      return;
   }

   unsubscribers.push(
      onOrderExecutable(event => {
         void PushService.send(event.wallet, 'order.executable', {
            orderId: event.orderId,
            keyId: event.keyId,
         });
      }),
      onGiftReceived(event => {
         void PushService.send(event.wallet, 'gift.received', {
            giftId: event.giftId,
            keyId: event.keyId,
            deepLink: event.deepLink,
         });
      }),
      onPriceAlert(event => {
         void PushService.send(event.wallet, 'price.alert', {
            keyId: event.keyId,
            deepLink: event.deepLink,
         });
      })
   );
}

export function stopPushEventListeners(): void {
   for (const unsub of unsubscribers) {
      unsub();
   }
   unsubscribers = [];
}
