export type WebhookEventName = 'buy' | 'sell';

export interface CreateWebhookInput {
  callbackUrl: string;
  events: WebhookEventName[];
}

export interface WebhookResponse {
  id: string;
  creatorId: string;
  callbackUrl: string;
  events: WebhookEventName[];
  isActive: boolean;
  isFailing: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookEventPayload {
  event_type: WebhookEventName;
  creator_id: string;
  buyer_or_seller_address: string;
  amount: string;
  price: string;
  fee_paid: string;
  timestamp: string;
}

export interface TradeEvent {
  type: WebhookEventName;
  creatorId: string;
  buyerOrSellerAddress: string;
  amount: string;
  price: string;
  feePaid: string;
  timestamp: string;
}
