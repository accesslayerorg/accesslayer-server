import type { TradeEvent, WebhookEventPayload } from './webhook.types';

export function buildWebhookPayload(event: TradeEvent): WebhookEventPayload {
    return {
        event_type: event.type,
        creator_id: event.creatorId,
        buyer_or_seller_address: event.buyerOrSellerAddress,
        amount: event.amount,
        price: event.price,
        fee_paid: event.feePaid,
        timestamp: event.timestamp,
    };
}
