import { randomUUID } from 'crypto';
import { getRedis } from '../../utils/redis.utils';
import { envConfig } from '../../config';
import {
  Subscription,
  SubscriptionTopic,
  SUBSCRIPTION_KEY_PREFIX,
  CURSOR_KEY_PREFIX,
  THROTTLED_KEY_PREFIX,
  CONNECTION_COUNT_KEY_PREFIX,
  WALLET_SUBSCRIPTIONS_KEY_PREFIX,
} from './subscription.types';

const SUBSCRIPTION_TTL_S = Math.floor(envConfig.SSE_SUBSCRIPTION_TTL_MS / 1000);
const MAX_SUBSCRIPTIONS = envConfig.SSE_MAX_SUBSCRIPTIONS_PER_WALLET;
const THROTTLE_DURATION_S = Math.ceil(envConfig.SSE_THROTTLE_DURATION_MS / 1000);

function subKey(subscriptionId: string): string {
  return `${SUBSCRIPTION_KEY_PREFIX}${subscriptionId}`;
}

function cursorKey(subscriptionId: string): string {
  return `${CURSOR_KEY_PREFIX}${subscriptionId}`;
}

function throttledKey(walletAddress: string): string {
  return `${THROTTLED_KEY_PREFIX}${walletAddress}`;
}

function connectionCountKey(walletAddress: string): string {
  return `${CONNECTION_COUNT_KEY_PREFIX}${walletAddress}`;
}

function walletSubsKey(walletAddress: string): string {
  return `${WALLET_SUBSCRIPTIONS_KEY_PREFIX}${walletAddress}`;
}

function generateSubscriptionId(): string {
  return `sub_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export async function createSubscription(
  walletAddress: string,
  topics: SubscriptionTopic[]
): Promise<Subscription> {
  const redis = getRedis();
  if (!redis) {
    throw new Error('Redis is unavailable; subscriptions require a Redis connection');
  }

  const walletKey = walletSubsKey(walletAddress);

  const currentCount = await redis.zcard(walletKey);
  if (currentCount >= MAX_SUBSCRIPTIONS) {
    throw Object.assign(new Error('Subscription limit reached'), {
      statusCode: 409,
      code: 'subscription_limit_reached',
    });
  }

  const subscriptionId = generateSubscriptionId();
  const now = Date.now();

  const sub: Subscription = {
    subscriptionId,
    walletAddress,
    topics,
    createdAt: now,
  };

  const pipeline = redis.pipeline();

  pipeline.hset(subKey(subscriptionId), {
    walletAddress,
    topics: JSON.stringify(topics),
    createdAt: String(now),
  });

  pipeline.expire(subKey(subscriptionId), SUBSCRIPTION_TTL_S);

  pipeline.zadd(walletKey, now, subscriptionId);
  pipeline.expire(walletKey, SUBSCRIPTION_TTL_S);

  await pipeline.exec();

  return sub;
}

export async function getSubscription(
  subscriptionId: string
): Promise<Subscription | null> {
  const redis = getRedis();
  if (!redis) return null;
  const data = await redis.hgetall(subKey(subscriptionId));
  if (!data || !data.walletAddress) return null;

  return {
    subscriptionId,
    walletAddress: data.walletAddress,
    topics: JSON.parse(data.topics) as SubscriptionTopic[],
    createdAt: Number(data.createdAt),
  };
}

export async function deleteSubscription(subscriptionId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const sub = await getSubscription(subscriptionId);
  if (!sub) return;

  const pipeline = redis.pipeline();
  pipeline.del(subKey(subscriptionId));
  pipeline.del(cursorKey(subscriptionId));
  pipeline.zrem(walletSubsKey(sub.walletAddress), subscriptionId);
  await pipeline.exec();
}

export async function touchSubscription(subscriptionId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.expire(subKey(subscriptionId), SUBSCRIPTION_TTL_S);
}

export async function getLastCursor(
  subscriptionId: string
): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  return redis.get(cursorKey(subscriptionId));
}

export async function saveCursor(
  subscriptionId: string,
  cursor: string
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(cursorKey(subscriptionId), cursor);
}

export async function isThrottled(walletAddress: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  const exists = await redis.exists(throttledKey(walletAddress));
  return exists === 1;
}

export async function setThrottled(walletAddress: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.setex(throttledKey(walletAddress), THROTTLE_DURATION_S, '1');
}

export async function incrementConnectionCount(
  walletAddress: string
): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;
  const count = await redis.incr(connectionCountKey(walletAddress));
  await redis.expire(connectionCountKey(walletAddress), 60);
  return count;
}

export async function decrementConnectionCount(
  walletAddress: string
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.decr(connectionCountKey(walletAddress));
}

export async function getWalletSubscriptions(
  walletAddress: string
): Promise<Subscription[]> {
  const redis = getRedis();
  if (!redis) return [];
   const ids = await redis.zrange(
     walletSubsKey(walletAddress),
     '0',
     '-1'
   );

  const subs: Subscription[] = [];
  for (const id of ids) {
    const sub = await getSubscription(id);
    if (sub) subs.push(sub);
  }
  return subs;
}

export async function getSubscriptionsByTopic(
  topic: string
): Promise<Subscription[]> {
  const redis = getRedis();
  if (!redis) return [];
  const ids = await redis.keys(`${SUBSCRIPTION_KEY_PREFIX}*`);
  const subs: Subscription[] = [];

  for (const key of ids) {
    const data = await redis.hgetall(key);
    if (!data.walletAddress) continue;

    const topics = JSON.parse(data.topics) as SubscriptionTopic[];
    if (topics.includes(topic as SubscriptionTopic)) {
      subs.push({
        subscriptionId: key.replace(SUBSCRIPTION_KEY_PREFIX, ''),
        walletAddress: data.walletAddress,
        topics,
        createdAt: Number(data.createdAt),
      });
    }
  }

  return subs;
}

export async function pruneExpiredSubscriptions(): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;
  const walletKeys = await redis.keys(`${WALLET_SUBSCRIPTIONS_KEY_PREFIX}*`);

  let pruned = 0;
  for (const wk of walletKeys) {
    const ids = await redis.zrange(wk, '0', '-1');
    for (const id of ids) {
      const exists = await redis.exists(subKey(id));
      if (exists === 0) {
        await redis.zrem(wk, id);
        await redis.del(cursorKey(id));
        pruned++;
      }
    }
  }

  return pruned;
}
