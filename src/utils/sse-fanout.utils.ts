import { Response } from 'express';
import { envConfig } from '../config';
import { logger } from './logger.utils';
import {
   getSubscription,
   saveCursor,
   setThrottled,
   decrementConnectionCount,
} from '../modules/subscriptions/subscription.service';
import type {
   SseEvent,
   SseConnectionState,
} from '../modules/subscriptions/subscription.types';

const HEARTBEAT_INTERVAL_MS = envConfig.SSE_HEARTBEAT_INTERVAL_MS;
const QUEUE_CAPACITY = envConfig.SSE_QUEUE_CAPACITY;
const QUEUE_FULL_TIMEOUT_MS = envConfig.SSE_QUEUE_FULL_TIMEOUT_MS;
const REPLAY_MAX_EVENTS = envConfig.SSE_REPLAY_MAX_EVENTS;

const connections = new Map<string, SseConnectionState>();

export function getConnection(
   subscriptionId: string
): SseConnectionState | undefined {
   return connections.get(subscriptionId);
}

export function getAllConnections(): Map<string, SseConnectionState> {
   return connections;
}

export function registerConnection(
   subscriptionId: string,
   walletAddress: string,
   res: Response
): SseConnectionState {
   const state: SseConnectionState = {
      res,
      subscriptionId,
      walletAddress,
      queue: [],
      queueFullSince: null,
      closed: false,
      heartbeatInterval: null,
   };

   connections.set(subscriptionId, state);

   state.heartbeatInterval = setInterval(() => {
      if (state.closed) return;
      try {
         res.write(': heartbeat\n\n');
      } catch {
         closeConnection(subscriptionId);
      }
   }, HEARTBEAT_INTERVAL_MS);

   return state;
}

export function closeConnection(subscriptionId: string): void {
   const state = connections.get(subscriptionId);
   if (!state || state.closed) return;

   state.closed = true;

   if (state.heartbeatInterval) {
      clearInterval(state.heartbeatInterval);
      state.heartbeatInterval = null;
   }

   decrementConnectionCount(state.walletAddress).catch(() => {});

   connections.delete(subscriptionId);
}

export function sendSseEvent(subscriptionId: string, event: SseEvent): boolean {
   const state = connections.get(subscriptionId);
   if (!state || state.closed) return false;

   if (state.queue.length >= QUEUE_CAPACITY) {
      if (state.queueFullSince === null) {
         state.queueFullSince = Date.now();
         logger.warn(
            { subscriptionId, queueDepth: state.queue.length },
            'sse_queue_full'
         );
      } else if (Date.now() - state.queueFullSince >= QUEUE_FULL_TIMEOUT_MS) {
         forceCloseConnection(subscriptionId);
         return false;
      }
      return false;
   }

   state.queueFullSince = null;
   state.queue.push(event);
   drainQueue(subscriptionId);
   return true;
}

function drainQueue(subscriptionId: string): void {
   const state = connections.get(subscriptionId);
   if (!state || state.closed) return;

   while (state.queue.length > 0) {
      if (state.closed) return;

      const event = state.queue[0];

      try {
         state.res.write(
            `id: ${event.cursor}\nevent: ${event.topic}\ndata: ${JSON.stringify(event.payload)}\n\n`
         );

         state.queue.shift();

         saveCursor(subscriptionId, event.cursor).catch(err => {
            logger.error({ err, subscriptionId }, 'sse_save_cursor_failed');
         });
      } catch (err) {
         logger.error({ err, subscriptionId }, 'sse_write_error');
         closeConnection(subscriptionId);
         return;
      }
   }
}

async function forceCloseConnection(subscriptionId: string): Promise<void> {
   const state = connections.get(subscriptionId);
   if (!state || state.closed) return;

   logger.warn(
      { subscriptionId, walletAddress: state.walletAddress },
      'sse_force_close_slow_client'
   );

   state.closed = true;

   if (state.heartbeatInterval) {
      clearInterval(state.heartbeatInterval);
      state.heartbeatInterval = null;
   }

   try {
      state.res.write(': connection closed: slow client\n\n');
      state.res.end();
   } catch {}

   connections.delete(subscriptionId);
   decrementConnectionCount(state.walletAddress).catch(() => {});
   await setThrottled(state.walletAddress);
}

export async function fanOutEvent(
   walletAddress: string,
   topic: string,
   payload: unknown,
   cursor: string
): Promise<void> {
   const event: SseEvent = {
      cursor,
      topic,
      payload,
   };

   const drainPromises: Promise<void>[] = [];

   for (const [subId, state] of connections) {
      if (state.closed || state.walletAddress !== walletAddress) continue;

      const sub = await getSubscription(subId);
      if (!sub || !sub.topics.includes(topic as any)) continue;

      sendSseEvent(subId, event);
   }

   await Promise.all(drainPromises);
}

export async function replayEvents(
   subscriptionId: string,
   lastEventId: string | null,
   events: SseEvent[]
): Promise<{ replayed: number; truncated: boolean }> {
   const state = connections.get(subscriptionId);
   if (!state || state.closed) return { replayed: 0, truncated: false };

   let replayEvents: SseEvent[];

   if (lastEventId) {
      const lastIndex = events.findIndex(e => e.cursor === lastEventId);
      if (lastIndex >= 0) {
         replayEvents = events.slice(lastIndex + 1);
      } else {
         replayEvents = events;
      }
   } else {
      replayEvents = events;
   }

   if (replayEvents.length > REPLAY_MAX_EVENTS) {
      replayEvents = replayEvents.slice(
         replayEvents.length - REPLAY_MAX_EVENTS
      );
      try {
         state.res.setHeader('X-Replay-Truncated', 'true');
      } catch {}
   }

   for (const event of replayEvents) {
      if (state.closed) break;

      try {
         state.res.write(
            `id: ${event.cursor}\nevent: ${event.topic}\ndata: ${JSON.stringify(event.payload)}\n\n`
         );
         await saveCursor(subscriptionId, event.cursor);
      } catch {
         closeConnection(subscriptionId);
         break;
      }
   }

   return {
      replayed: replayEvents.length,
      truncated:
         replayEvents.length > REPLAY_MAX_EVENTS ||
         events.length > REPLAY_MAX_EVENTS,
   };
}

export function broadcastServerClosing(): void {
   for (const [, state] of connections) {
      if (state.closed) continue;
      try {
         state.res.write('event: server_closing\ndata: {}\n\n');
      } catch {}
   }
}

export function closeAllConnections(): void {
   const allIds = Array.from(connections.keys());
   for (const id of allIds) {
      closeConnection(id);
   }
}
