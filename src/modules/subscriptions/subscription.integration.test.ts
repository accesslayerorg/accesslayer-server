jest.mock('../../utils/redis.utils', () => ({
   getRedis: jest.fn(),
   connectRedis: jest.fn().mockResolvedValue(undefined),
   disconnectRedis: jest.fn().mockResolvedValue(undefined),
   isRedisReady: jest.fn(() => true),
}));

jest.mock('../../config', () => ({
   envConfig: {
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'test_jwt_secret_key_32_bytes_long_test___',
      JWT_EXPIRES_IN: '1h',
      SSE_HEARTBEAT_INTERVAL_MS: 100,
      SSE_QUEUE_CAPACITY: 5,
      SSE_QUEUE_FULL_TIMEOUT_MS: 2000,
      SSE_THROTTLE_DURATION_MS: 5000,
      SSE_MAX_CONNECTIONS_PER_WALLET: 2,
      SSE_MAX_SUBSCRIPTIONS_PER_WALLET: 5,
      SSE_SUBSCRIPTION_TTL_MS: 86400000,
      SSE_REPLAY_MAX_EVENTS: 10,
      SSE_PRUNE_INTERVAL_MS: 300000,
   },
   appConfig: { allowedOrigins: [] },
}));

import { Response } from 'express';
import { getRedis } from '../../utils/redis.utils';
import {
   createSubscription,
   getSubscription,
   deleteSubscription,
   getWalletSubscriptions,
   getSubscriptionsByTopic,
   isThrottled,
   setThrottled,
   incrementConnectionCount,
   decrementConnectionCount,
} from './subscription.service';
import {
   registerConnection,
   sendSseEvent,
   fanOutEvent,
   replayEvents,
   getAllConnections,
   broadcastServerClosing,
   closeAllConnections,
} from '../../utils/sse-fanout.utils';

const mockGetRedis = getRedis as jest.Mock;

interface RedisData {
   store: Map<string, string>;
   hashStore: Map<string, Record<string, string>>;
   sortedSets: Map<string, Array<{ score: number; member: string }>>;
}

interface RedisClient {
   status: string;
   on: jest.Mock;
   connect: jest.Mock;
   quit: jest.Mock;
   get: jest.Mock;
   set: jest.Mock;
   setex: jest.Mock;
   expire: jest.Mock;
   incr: jest.Mock;
   decr: jest.Mock;
   exists: jest.Mock;
   del: jest.Mock;
   hset: jest.Mock;
   hgetall: jest.Mock;
   zadd: jest.Mock;
   zcard: jest.Mock;
   zrange: jest.Mock;
   zrem: jest.Mock;
   keys: jest.Mock;
   pipeline: jest.Mock;
}

function buildRedisClient(): RedisClient {
   const data: RedisData = {
      store: new Map(),
      hashStore: new Map(),
      sortedSets: new Map(),
   };

   const pipelineOps: any[] = [];
   const pipeline: any = {
      hset: (k: string, d: any) => {
         pipelineOps.push({ cmd: 'hset', key: k, data: d });
         return pipeline;
      },
      expire: () => {
         pipelineOps.push({ cmd: 'expire' });
         return pipeline;
      },
      zadd: (k: string, s: number, m: string) => {
         pipelineOps.push({ cmd: 'zadd', key: k, score: s, member: m });
         return pipeline;
      },
      zrem: (k: string, m: string) => {
         pipelineOps.push({ cmd: 'zrem', key: k, member: m });
         return pipeline;
      },
      del: (k: string) => {
         pipelineOps.push({ cmd: 'del', key: k });
         return pipeline;
      },
      exec: jest.fn(async () => {
         const ops = pipelineOps.splice(0);
         for (const op of ops) {
            if (op.cmd === 'hset' && op.key && op.data) {
               data.hashStore.set(op.key, {
                  ...(data.hashStore.get(op.key) || {}),
                  ...op.data,
               });
            } else if (
               op.cmd === 'zadd' &&
               op.key &&
               op.score !== undefined &&
               op.member
            ) {
               if (!data.sortedSets.has(op.key))
                  data.sortedSets.set(op.key, []);
               data.sortedSets
                  .get(op.key)!
                  .push({ score: op.score, member: op.member });
            } else if (op.cmd === 'zrem' && op.key && op.member) {
               const set = data.sortedSets.get(op.key);
               if (set) {
                  const idx = set.findIndex((e: any) => e.member === op.member);
                  if (idx >= 0) set.splice(idx, 1);
               }
            } else if (op.cmd === 'del' && op.key) {
               data.store.delete(op.key);
               data.hashStore.delete(op.key);
            }
         }
         return ops.map(() => [null, 'OK']);
      }),
   };

   const client: RedisClient = {
      status: 'ready',
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue(undefined),
      get: jest.fn(async (k: string) => data.store.get(k) ?? null),
      set: jest.fn(async (k: string, v: string) => {
         data.store.set(k, v);
         return 'OK';
      }),
      setex: jest.fn(async (k: string, _t: number, v: string) => {
         data.store.set(k, v);
         return 'OK';
      }),
      expire: jest.fn().mockResolvedValue(1),
      incr: jest.fn(async (k: string) => {
         const v = parseInt(data.store.get(k) || '0', 10) + 1;
         data.store.set(k, String(v));
         return v;
      }),
      decr: jest.fn(async (k: string) => {
         const v = parseInt(data.store.get(k) || '1', 10) - 1;
         data.store.set(k, String(v));
         return v;
      }),
      exists: jest.fn(async (k: string) => (data.store.has(k) ? 1 : 0)),
      del: jest.fn(async (k: string) => {
         data.store.delete(k);
         data.hashStore.delete(k);
         return 1;
      }),
      hset: jest.fn(async (k: string, d: any) => {
         data.hashStore.set(k, { ...(data.hashStore.get(k) || {}), ...d });
         return 1;
      }),
      hgetall: jest.fn(async (k: string) => data.hashStore.get(k) || {}),
      zadd: jest.fn(async (k: string, s: number, m: string) => {
         if (!data.sortedSets.has(k)) data.sortedSets.set(k, []);
         data.sortedSets.get(k)!.push({ score: s, member: m });
         return 1;
      }),
      zcard: jest.fn(async (k: string) => data.sortedSets.get(k)?.length || 0),
      zrange: jest.fn(async (k: string) =>
         (data.sortedSets.get(k) || []).map((e: any) => e.member)
      ),
      zrem: jest.fn(async (k: string, m: string) => {
         const set = data.sortedSets.get(k);
         if (set) {
            const idx = set.findIndex((e: any) => e.member === m);
            if (idx >= 0) set.splice(idx, 1);
         }
         return 1;
      }),
      keys: jest.fn(async () => {
         const allKeys = new Set<string>();
         for (const k of data.hashStore.keys()) allKeys.add(k);
         for (const k of data.sortedSets.keys()) allKeys.add(k);
         for (const k of data.store.keys()) allKeys.add(k);
         return Array.from(allKeys);
      }),
      pipeline: jest.fn(() => pipeline),
   };

   return client;
}

function mockSseResponse(): Response & {
   writeBuffer: any[];
   statusCode: number;
   headers: Record<string, string>;
} {
   const res: any = {
      writeBuffer: [],
      statusCode: 200,
      headers: {},
      writeHead: jest.fn((code: number, headers?: Record<string, string>) => {
         res.statusCode = code;
         if (headers) Object.assign(res.headers, headers);
      }),
      write: jest.fn((chunk: string) => {
         res.writeBuffer.push(chunk);
         return true;
      }),
      end: jest.fn(),
      setHeader: jest.fn((k: string, v: string) => {
         res.headers[k] = v;
      }),
      getHeader: jest.fn((k: string) => res.headers[k]),
   };
   return res;
}

function sleep(ms: number): Promise<void> {
   return new Promise(resolve => setTimeout(resolve, ms));
}

const WALLET_A = 'GA-test-wallet-address-a';
const WALLET_B = 'GA-test-wallet-address-b';

beforeEach(() => {
   mockGetRedis.mockReset();
   mockGetRedis.mockReturnValue(buildRedisClient());
   closeAllConnections();
});

afterEach(() => {
   closeAllConnections();
});

describe('POST /subscriptions — subscription registry', () => {
   it('creates a subscription with topic filtering', async () => {
      const sub = await createSubscription(WALLET_A, ['key_buy', 'key_sell']);

      expect(sub.subscriptionId).toBeTruthy();
      expect(sub.walletAddress).toBe(WALLET_A);
      expect(sub.topics).toEqual(['key_buy', 'key_sell']);
      expect(sub.createdAt).toBeGreaterThan(0);

      const fetched = await getSubscription(sub.subscriptionId);
      expect(fetched).not.toBeNull();
      expect(fetched!.walletAddress).toBe(WALLET_A);
   });

   it('enforces the 5-subscription limit (returns 409)', async () => {
      for (let i = 0; i < 5; i++) {
         await createSubscription(WALLET_A, ['key_buy']);
      }

      await expect(
         createSubscription(WALLET_A, ['key_buy'])
      ).rejects.toMatchObject({
         code: 'subscription_limit_reached',
         statusCode: 409,
      });
   });

   it('allows up to 5 subscriptions', async () => {
      for (let i = 0; i < 5; i++) {
         const sub = await createSubscription(WALLET_A, ['key_buy']);
         expect(sub.subscriptionId).toBeTruthy();
      }
   });

   it('lists subscriptions for a wallet', async () => {
      await createSubscription(WALLET_A, ['key_buy']);
      await createSubscription(WALLET_A, ['key_sell']);

      const subs = await getWalletSubscriptions(WALLET_A);
      expect(subs).toHaveLength(2);
   });
});

describe('GET /subscriptions/:id/stream — SSE delivery', () => {
   it('delivers matching events in real time', async () => {
      const sub = await createSubscription(WALLET_A, ['key_buy']);
      const res = mockSseResponse();

      registerConnection(sub.subscriptionId, WALLET_A, res);

      const sent = sendSseEvent(sub.subscriptionId, {
         cursor: 'cursor-1',
         topic: 'key_buy',
         payload: { price: 100 },
      });

      expect(sent).toBe(true);

      await sleep(100);

      const allWritten = res.writeBuffer.join('');
      expect(allWritten).toContain('cursor-1');
      expect(allWritten).toContain('key_buy');
      expect(allWritten).toContain('"price":100');
   });
});

describe('Fan-out — does not block ingestion', () => {
   it('fanOutEvent pushes to connections asynchronously', async () => {
      const sub = await createSubscription(WALLET_A, ['key_buy']);
      const res = mockSseResponse();

      registerConnection(sub.subscriptionId, WALLET_A, res);

      await fanOutEvent(WALLET_A, 'key_buy', { price: 200 }, 'fanout-1');

      await sleep(100);

      const allWritten = res.writeBuffer.join('');
      expect(allWritten).toContain('fanout-1');
      expect(allWritten).toContain('"price":200');
   });
});

describe('Cursor-based replay — at-least-once delivery', () => {
   it('replays events after a cursor on reconnect', async () => {
      const sub = await createSubscription(WALLET_A, ['key_buy']);
      const res = mockSseResponse();

      registerConnection(sub.subscriptionId, WALLET_A, res);

      const events = [
         { cursor: 'c1', topic: 'key_buy', payload: { id: 1 } },
         { cursor: 'c2', topic: 'key_buy', payload: { id: 2 } },
         { cursor: 'c3', topic: 'key_buy', payload: { id: 3 } },
      ];

      const result = await replayEvents(sub.subscriptionId, 'c1', events);

      expect(result.replayed).toBe(2);
      const allWritten = res.writeBuffer.join('');
      expect(allWritten).toContain('c2');
      expect(allWritten).toContain('c3');
      expect(allWritten).not.toContain('c1');
   });

   it('replays all events if no cursor provided', async () => {
      const sub = await createSubscription(WALLET_A, ['key_buy']);
      const res = mockSseResponse();

      registerConnection(sub.subscriptionId, WALLET_A, res);

      const events = [
         { cursor: 'c1', topic: 'key_buy', payload: { id: 1 } },
         { cursor: 'c2', topic: 'key_buy', payload: { id: 2 } },
      ];

      const result = await replayEvents(sub.subscriptionId, null, events);

      expect(result.replayed).toBe(2);
   });

   it('caps replay with X-Replay-Truncated header', async () => {
      const sub = await createSubscription(WALLET_A, ['key_buy']);
      const res = mockSseResponse();

      registerConnection(sub.subscriptionId, WALLET_A, res);

      const manyEvents = Array.from({ length: 15 }, (_, i) => ({
         cursor: `c${i}`,
         topic: 'key_buy',
         payload: { id: i },
      }));

      const result = await replayEvents(sub.subscriptionId, null, manyEvents);

      expect(result.truncated).toBe(true);
      expect(res.headers['X-Replay-Truncated']).toBe('true');
   });
});

describe('Backpressure — slow-client protection', () => {
   it('per-connection queue capped at capacity', async () => {
      const sub = await createSubscription(WALLET_A, ['key_buy']);
      const res = mockSseResponse();

      registerConnection(sub.subscriptionId, WALLET_A, res);

      for (let i = 0; i < 10; i++) {
         sendSseEvent(sub.subscriptionId, {
            cursor: `q${i}`,
            topic: 'key_buy',
            payload: { n: i },
         });
      }

      const state = getAllConnections().get(sub.subscriptionId);
      expect(state).toBeDefined();
      expect(state!.queue.length).toBeLessThanOrEqual(5);
   });

   it('force closes connection when queue stays full past timeout', async () => {
      const sub = await createSubscription(WALLET_A, ['key_buy']);
      const res = mockSseResponse();

      res.write = jest.fn(() => false) as any;

      registerConnection(sub.subscriptionId, WALLET_A, res);

      const state = getAllConnections().get(sub.subscriptionId)!;

      state.queueFullSince = Date.now() - 3000;
      state.queue = [];

      for (let i = 0; i < 5; i++) {
         state.queue.push({
            cursor: `bp${i}`,
            topic: 'key_buy',
            payload: { n: i },
         });
      }

      sendSseEvent(sub.subscriptionId, {
         cursor: 'bp-over',
         topic: 'key_buy',
         payload: { n: 999 },
      });

      expect(state.closed).toBe(true);
   });
});

describe('THROTTLED subscription', () => {
   it('blocks reconnection for throttle duration', async () => {
      await setThrottled(WALLET_A);
      const throttled = await isThrottled(WALLET_A);
      expect(throttled).toBe(true);
   });
});

describe('Connection limits', () => {
   it('tracks connection count via Redis', async () => {
      const count1 = await incrementConnectionCount(WALLET_A);
      expect(count1).toBe(1);

      const count2 = await incrementConnectionCount(WALLET_A);
      expect(count2).toBe(2);

      const count3 = await incrementConnectionCount(WALLET_A);
      expect(count3).toBe(3);
   });

   it('decrements connection count on disconnect', async () => {
      await incrementConnectionCount(WALLET_A);
      await decrementConnectionCount(WALLET_A);
   });
});

describe('Heartbeat and connection hygiene', () => {
   it('sends heartbeat comment on interval', async () => {
      jest.useFakeTimers();
      const sub = await createSubscription(WALLET_A, ['key_buy']);
      const res = mockSseResponse();

      registerConnection(sub.subscriptionId, WALLET_A, res);

      jest.advanceTimersByTime(150);
      jest.useRealTimers();

      await sleep(50);

      const heartbeats = res.writeBuffer.filter((chunk: string) =>
         chunk.includes(': heartbeat')
      );
      expect(heartbeats.length).toBeGreaterThanOrEqual(1);
   });

   it('broadcasts server_closing to all connections', async () => {
      const sub = await createSubscription(WALLET_A, ['key_buy']);
      const res = mockSseResponse();

      registerConnection(sub.subscriptionId, WALLET_A, res);

      broadcastServerClosing();

      const allWritten = res.writeBuffer.join('');
      expect(allWritten).toContain('server_closing');
   });

   it('closeAllConnections cleans up all connection state', async () => {
      const sub = await createSubscription(WALLET_A, ['key_buy']);
      const res = mockSseResponse();

      registerConnection(sub.subscriptionId, WALLET_A, res);

      expect(getAllConnections().size).toBe(1);

      closeAllConnections();

      expect(getAllConnections().size).toBe(0);
   });
});

describe('Subscription deletion', () => {
   it('deletes subscription and cleans up Redis keys', async () => {
      const sub = await createSubscription(WALLET_A, ['key_buy']);

      const fetched = await getSubscription(sub.subscriptionId);
      expect(fetched).not.toBeNull();

      await deleteSubscription(sub.subscriptionId);

      const afterDelete = await getSubscription(sub.subscriptionId);
      expect(afterDelete).toBeNull();
   });
});

describe('getSubscriptionsByTopic', () => {
   it('returns subscriptions matching a topic', async () => {
      await createSubscription(WALLET_A, ['key_buy']);
      await createSubscription(WALLET_B, ['key_sell']);
      await createSubscription(WALLET_A, ['key_buy', 'follower_added']);

      const subs = await getSubscriptionsByTopic('key_buy');
      expect(subs).toHaveLength(2);
      expect(subs.every(s => s.topics.includes('key_buy'))).toBe(true);
   });
});
