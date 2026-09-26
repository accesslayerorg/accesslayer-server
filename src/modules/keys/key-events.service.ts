import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.utils';

export interface KeyRegisteredEventPayload {
   keyAddress: string;
   creatorWallet: string;
   metadata: Record<string, unknown>;
   registeredAt: Date;
}

/**
 * Internal event emitter instance for key lifecycle events.
 */
export const keyEvents = new EventEmitter();

/**
 * Emits the internal `key_registered` event for downstream services and logging.
 */
export function emitKeyRegisteredEvent(
   payload: KeyRegisteredEventPayload
): void {
   logger.info(
      {
         keyAddress: payload.keyAddress,
         creatorWallet: payload.creatorWallet,
         registeredAt: payload.registeredAt.toISOString(),
      },
      'Emitting key_registered event'
   );

   keyEvents.emit('key_registered', payload);
}
