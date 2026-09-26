export type SubscriptionTopic = 'key_buy' | 'key_sell' | 'follower_added';

export const VALID_TOPICS: SubscriptionTopic[] = [
   'key_buy',
   'key_sell',
   'follower_added',
];

export interface Subscription {
   subscriptionId: string;
   walletAddress: string;
   topics: SubscriptionTopic[];
   createdAt: number;
}

export interface SseEvent {
   cursor: string;
   topic: string;
   payload: unknown;
}

export interface SseConnectionState {
   res: import('express').Response;
   subscriptionId: string;
   walletAddress: string;
   queue: SseEvent[];
   queueFullSince: number | null;
   closed: boolean;
   heartbeatInterval: ReturnType<typeof setInterval> | null;
}

export const SUBSCRIPTION_KEY_PREFIX = 'subscriptions:';
export const CURSOR_KEY_PREFIX = 'cursor:';
export const THROTTLED_KEY_PREFIX = 'throttled:';
export const CONNECTION_COUNT_KEY_PREFIX = 'connection_count:';
export const WALLET_SUBSCRIPTIONS_KEY_PREFIX = 'wallet_subs:';
