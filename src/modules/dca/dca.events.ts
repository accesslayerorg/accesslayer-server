// src/modules/dca/dca.events.ts
import { EventEmitter } from 'events';

export interface DcaPausedEventPayload {
   planId: string;
   wallet: string;
   keyId: string;
   consecutiveFailures: number;
   reason: string;
   pausedAt: string;
}

export const dcaEventEmitter = new EventEmitter();

export function emitDcaPaused(payload: DcaPausedEventPayload): void {
   dcaEventEmitter.emit('dca.paused', payload);
}
