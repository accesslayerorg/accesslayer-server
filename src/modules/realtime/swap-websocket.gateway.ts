import type { IncomingMessage, Server } from 'http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { logger } from '../../utils/logger.utils';

const ENDPOINT_PATH = '/ws';
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_SUBSCRIPTIONS_PER_CLIENT = 100;

export interface SwapEventMessage {
   key_id: string;
   /** Unit price in stroops, serialized as a string to preserve precision. */
   price: string;
   /** Number of keys traded, serialized as a string for exactness. */
   amount: string;
   direction: 'buy' | 'sell';
   /** ISO-8601 timestamp from the indexed on-chain event. */
   timestamp: string;
}

interface ClientState {
   socket: WebSocket;
   subscriptions: Set<string>;
   alive: boolean;
}

export class SwapWebSocketGateway {
   private readonly wss: WebSocketServer;
   private readonly clients = new Map<WebSocket, ClientState>();
   private readonly subscribersByKey = new Map<string, Set<WebSocket>>();
   private readonly heartbeatTimer: NodeJS.Timeout;
   private closed = false;

   constructor(
      private readonly server: Server,
      heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS
   ) {
      this.wss = new WebSocketServer({
         noServer: true,
         maxPayload: MAX_MESSAGE_BYTES,
         perMessageDeflate: false,
      });
      this.wss.on('connection', socket => this.addClient(socket));
      this.server.on('upgrade', this.handleUpgrade);
      this.heartbeatTimer = setInterval(
         () => this.checkHeartbeats(),
         heartbeatIntervalMs
      );
      this.heartbeatTimer.unref();
   }

   private readonly handleUpgrade = (
      request: IncomingMessage,
      socket: import('net').Socket,
      head: Buffer
   ): void => {
      let pathname: string;
      try {
         pathname = new URL(
            request.url ?? '/',
            `http://${request.headers.host ?? 'localhost'}`
         ).pathname;
      } catch {
         socket.destroy();
         return;
      }

      if (pathname !== ENDPOINT_PATH) {
         socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
         socket.destroy();
         return;
      }

      this.wss.handleUpgrade(request, socket, head, client => {
         this.wss.emit('connection', client, request);
      });
   };

   private checkHeartbeats(): void {
      for (const state of this.clients.values()) {
         if (!state.alive) {
            this.removeClient(state);
            state.socket.terminate();
            continue;
         }

         state.alive = false;
         state.socket.ping((error?: Error) => {
            if (error) {
               logger.debug({ error }, 'WebSocket heartbeat ping failed');
               this.removeClient(state);
               state.socket.terminate();
            }
         });
      }
   }

   private addClient(socket: WebSocket): void {
      const state: ClientState = {
         socket,
         subscriptions: new Set(),
         alive: true,
      };
      this.clients.set(socket, state);
      socket.on('pong', () => {
         state.alive = true;
      });
      socket.on('message', (raw: RawData) => this.handleMessage(state, raw));
      socket.on('close', () => this.removeClient(state));
      socket.on('error', error => {
         logger.debug({ error }, 'WebSocket client connection error');
         this.removeClient(state);
      });
   }

   private handleMessage(state: ClientState, raw: RawData): void {
      let message: unknown;
      try {
         message = JSON.parse(raw.toString());
      } catch {
         this.sendError(
            state.socket,
            'invalid_json',
            'Message must be valid JSON.'
         );
         return;
      }

      if (!message || typeof message !== 'object' || Array.isArray(message)) {
         this.sendError(
            state.socket,
            'invalid_message',
            'Message must be an object.'
         );
         return;
      }

      const command = message as {
         type?: unknown;
         action?: unknown;
         key_id?: unknown;
      };
      const type = command.type ?? command.action;
      const keyId =
         typeof command.key_id === 'string' ? command.key_id.trim() : '';
      if (type !== 'subscribe' && type !== 'unsubscribe') {
         this.sendError(
            state.socket,
            'unsupported_message',
            'Use subscribe or unsubscribe.'
         );
         return;
      }
      if (!keyId || keyId.length > 256) {
         this.sendError(
            state.socket,
            'invalid_key_id',
            'key_id must be a non-empty string of at most 256 characters.'
         );
         return;
      }

      if (type === 'subscribe') {
         if (
            !state.subscriptions.has(keyId) &&
            state.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_CLIENT
         ) {
            this.sendError(
               state.socket,
               'subscription_limit',
               'A connection can subscribe to at most 100 keys.'
            );
            return;
         }
         state.subscriptions.add(keyId);
         let subscribers = this.subscribersByKey.get(keyId);
         if (!subscribers) {
            subscribers = new Set();
            this.subscribersByKey.set(keyId, subscribers);
         }
         subscribers.add(state.socket);
      } else {
         state.subscriptions.delete(keyId);
         const subscribers = this.subscribersByKey.get(keyId);
         subscribers?.delete(state.socket);
         if (subscribers?.size === 0) this.subscribersByKey.delete(keyId);
      }

      this.send(state.socket, { type: `${type}d`, key_id: keyId });
   }

   private sendError(socket: WebSocket, code: string, message: string): void {
      this.send(socket, { type: 'error', code, message });
   }

   private send(socket: WebSocket, message: unknown): void {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(message), error => {
         if (error) logger.debug({ error }, 'Failed to send WebSocket message');
      });
   }

   private removeClient(state: ClientState): void {
      if (!this.clients.delete(state.socket)) return;
      for (const keyId of state.subscriptions) {
         const subscribers = this.subscribersByKey.get(keyId);
         subscribers?.delete(state.socket);
         if (subscribers?.size === 0) this.subscribersByKey.delete(keyId);
      }
      state.subscriptions.clear();
   }

   publish(event: SwapEventMessage): void {
      const subscribers = this.subscribersByKey.get(event.key_id);
      if (!subscribers?.size) return;
      const payload = { type: 'swap_event', ...event };
      for (const client of subscribers) this.send(client, payload);
   }

   close(): void {
      if (this.closed) return;
      this.closed = true;
      clearInterval(this.heartbeatTimer);
      this.server.off('upgrade', this.handleUpgrade);
      for (const state of this.clients.values()) {
         state.socket.terminate();
         this.removeClient(state);
      }
      this.wss.close();
   }
}

let activeGateway: SwapWebSocketGateway | undefined;

/** Attach the live swap endpoint to the same HTTP server as the REST API. */
export function attachSwapWebSocketGateway(server: Server): () => void {
   if (activeGateway) {
      throw new Error('The swap WebSocket gateway is already attached.');
   }
   const gateway = new SwapWebSocketGateway(server);
   activeGateway = gateway;
   return () => {
      if (activeGateway === gateway) activeGateway = undefined;
      gateway.close();
   };
}

/** Broadcast only after the corresponding chain event has been indexed. */
export function broadcastSwapEvent(event: SwapEventMessage): void {
   activeGateway?.publish(event);
}
