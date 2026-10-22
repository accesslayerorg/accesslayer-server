import type { IncomingMessage, Server } from 'http';
import { WebSocket, WebSocketServer } from 'ws';

export interface SwapPriceEvent {
   key_id: string;
   price: string;
   amount: string;
   direction: 'buy' | 'sell';
   timestamp: string;
}

type SubscribedSocket = WebSocket & { subscriptions?: Set<string>; isAlive?: boolean };

const sockets = new Set<SubscribedSocket>();
const closeHandlers = new WeakMap<Server, () => void>();

/** Attach the price stream at `/ws` and close stale clients every 30 seconds. */
export function attachPriceWebSocketGateway(server: Server): void {
   const gateway = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });

   server.on('upgrade', (request: IncomingMessage, socket, head) => {
      let pathname: string;
      try {
         pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      } catch {
         socket.destroy();
         return;
      }
      if (pathname !== '/ws') {
         socket.destroy();
         return;
      }

      gateway.handleUpgrade(request, socket, head, client => {
         gateway.emit('connection', client, request);
      });
   });

   gateway.on('connection', (client: SubscribedSocket) => {
      client.subscriptions = new Set();
      client.isAlive = true;
      sockets.add(client);
      client.on('pong', () => { client.isAlive = true; });
      client.on('message', data => {
         let message: { type?: string; key_id?: string };
         try {
            message = JSON.parse(data.toString());
         } catch {
            client.send(JSON.stringify({ type: 'error', error: 'Invalid JSON message' }));
            return;
         }

         const keyId = message.key_id?.trim();
         if (!keyId || keyId.length > 128 || !['subscribe', 'unsubscribe'].includes(message.type ?? '')) {
            client.send(JSON.stringify({ type: 'error', error: 'Expected subscribe or unsubscribe with a valid key_id' }));
            return;
         }

         if (message.type === 'subscribe') client.subscriptions?.add(keyId);
         else client.subscriptions?.delete(keyId);
         client.send(JSON.stringify({ type: message.type, key_id: keyId }));
      });
      client.on('close', () => sockets.delete(client));
      client.on('error', () => sockets.delete(client));
   });

   const heartbeat = setInterval(() => {
      for (const client of sockets) {
         if (client.isAlive === false) {
            sockets.delete(client);
            client.terminate();
            continue;
         }
         client.isAlive = false;
         client.ping();
      }
   }, 30_000);
   heartbeat.unref();
   const close = () => {
      clearInterval(heartbeat);
      for (const client of sockets) client.terminate();
      sockets.clear();
      gateway.close();
   };
   closeHandlers.set(server, close);
   server.once('close', close);
}

/** Close WebSocket clients before the HTTP server drains its connections. */
export function closePriceWebSocketGateway(server: Server): void {
   const close = closeHandlers.get(server);
   if (close) {
      closeHandlers.delete(server);
      close();
   }
}

/** Publish an indexed bonding-curve trade to clients subscribed to its key. */
export function broadcastSwapPrice(event: SwapPriceEvent): void {
   const payload = JSON.stringify({ type: 'swap', ...event });
   for (const client of sockets) {
      if (client.readyState === WebSocket.OPEN && client.subscriptions?.has(event.key_id)) {
         client.send(payload);
      }
   }
}
