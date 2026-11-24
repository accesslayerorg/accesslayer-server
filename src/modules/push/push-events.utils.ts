import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.utils';

export const PUSH_EVENTS = [
   'order.executable',
   'gift.received',
   'price.alert',
] as const;

export type PushEventType = (typeof PUSH_EVENTS)[number];

export interface GiftReceivedEvent {
   type: 'gift.received';
   wallet: string;
   keyId?: string;
   giftId?: string;
   deepLink?: string;
}

export interface PriceAlertEvent {
   type: 'price.alert';
   wallet: string;
   keyId: string;
   deepLink?: string;
}

const pushEventBus = new EventEmitter();
pushEventBus.setMaxListeners(50);

export function emitGiftReceived(payload: GiftReceivedEvent): void {
   try {
      pushEventBus.emit('gift.received', payload);
   } catch (error) {
      logger.error({ error }, 'Failed to emit gift.received event');
   }
}

export function onGiftReceived(
   handler: (payload: GiftReceivedEvent) => void
): () => void {
   pushEventBus.on('gift.received', handler);
   return () => pushEventBus.off('gift.received', handler);
}

export function emitPriceAlert(payload: PriceAlertEvent): void {
   try {
      pushEventBus.emit('price.alert', payload);
   } catch (error) {
      logger.error({ error }, 'Failed to emit price.alert event');
   }
}

export function onPriceAlert(
   handler: (payload: PriceAlertEvent) => void
): () => void {
   pushEventBus.on('price.alert', handler);
   return () => pushEventBus.off('price.alert', handler);
}
