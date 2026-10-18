import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import {
   SwapWebSocketGateway,
   type SwapEventMessage,
} from './swap-websocket.gateway';

const EVENT: SwapEventMessage = {
   key_id: 'creator-key-1',
   price: '12000000',
   amount: '2',
   direction: 'buy',
   timestamp: '2026-10-18T12:00:00.000Z',
};

describe('SwapWebSocketGateway', () => {
   let server: Server;
   let gateway: SwapWebSocketGateway;
   let url: string;
   const clients: WebSocket[] = [];

   beforeEach(async () => {
      server = createServer();
      await new Promise<void>(resolve =>
         server.listen(0, '127.0.0.1', resolve)
      );
      const address = server.address() as AddressInfo;
      url = `ws://127.0.0.1:${address.port}/ws`;
      gateway = new SwapWebSocketGateway(server);
   });

   afterEach(async () => {
      gateway.close();
      for (const client of clients.splice(0)) client.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
   });

   async function connect(): Promise<WebSocket> {
      const client = new WebSocket(url);
      clients.push(client);
      await new Promise<void>((resolve, reject) => {
         client.once('open', resolve);
         client.once('error', reject);
      });
      return client;
   }

   function nextMessage(client: WebSocket): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
         const timeout = setTimeout(
            () => reject(new Error('Timed out waiting for WebSocket message')),
            1000
         );
         client.once('message', data => {
            clearTimeout(timeout);
            resolve(JSON.parse(data.toString()) as Record<string, unknown>);
         });
      });
   }

   async function subscribe(client: WebSocket, keyId: string): Promise<void> {
      const response = nextMessage(client);
      client.send(JSON.stringify({ type: 'subscribe', key_id: keyId }));
      expect(await response).toEqual({ type: 'subscribed', key_id: keyId });
   }

   it('fans a swap out only to subscribers of its key and deduplicates subscriptions', async () => {
      const first = await connect();
      const second = await connect();
      const unrelated = await connect();
      await subscribe(first, EVENT.key_id);
      await subscribe(first, EVENT.key_id);
      await subscribe(second, EVENT.key_id);
      await subscribe(unrelated, 'another-key');

      const firstUpdate = nextMessage(first);
      const secondUpdate = nextMessage(second);
      let unrelatedUpdates = 0;
      unrelated.on('message', () => unrelatedUpdates++);
      gateway.publish(EVENT);

      const expected = { type: 'swap_event', ...EVENT };
      await expect(firstUpdate).resolves.toEqual(expected);
      await expect(secondUpdate).resolves.toEqual(expected);
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(unrelatedUpdates).toBe(0);
   });

   it('removes closed clients and subscriptions so a reconnect receives one update', async () => {
      const disconnected = await connect();
      await subscribe(disconnected, EVENT.key_id);
      disconnected.close();
      await new Promise<void>(resolve =>
         disconnected.once('close', () => resolve())
      );

      const reconnected = await connect();
      await subscribe(reconnected, EVENT.key_id);
      const update = nextMessage(reconnected);
      gateway.publish(EVENT);
      await expect(update).resolves.toEqual({ type: 'swap_event', ...EVENT });
   });

   it('rejects malformed commands and invalid key identifiers', async () => {
      const client = await connect();
      const malformed = nextMessage(client);
      client.send('{');
      await expect(malformed).resolves.toMatchObject({
         type: 'error',
         code: 'invalid_json',
      });

      const invalid = nextMessage(client);
      client.send(JSON.stringify({ type: 'subscribe', key_id: '  ' }));
      await expect(invalid).resolves.toMatchObject({
         type: 'error',
         code: 'invalid_key_id',
      });
   });

   it('terminates a client that misses its heartbeat pong', async () => {
      gateway.close();
      gateway = new SwapWebSocketGateway(server, 20);
      const client = await connect();
      // `ws` normally answers ping frames automatically. Suppress that reply
      // so the gateway sees a missed pong on the next heartbeat tick.
      (client as WebSocket & { pong: () => void }).pong = () => {};
      const closed = new Promise<number>(resolve => {
         client.once('close', code => resolve(code));
      });

      await expect(closed).resolves.toBe(1006);
   });
});
