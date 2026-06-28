import { buildWebhookPayload } from './webhook-payload.utils';
import type { TradeEvent, WebhookEventPayload } from './webhook.types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTradeEvent(overrides: Partial<TradeEvent> = {}): TradeEvent {
    return {
        type: 'buy',
        creatorId: 'creator-1',
        buyerOrSellerAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        amount: '10',
        price: '50',
        feePaid: '1',
        timestamp: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildWebhookPayload', () => {
    it('maps all fields correctly for a buy event', () => {
        const event = makeTradeEvent({ type: 'buy' });
        const payload = buildWebhookPayload(event);

        expect(payload).toEqual<WebhookEventPayload>({
            event_type: 'buy',
            creator_id: 'creator-1',
            buyer_or_seller_address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            amount: '10',
            price: '50',
            fee_paid: '1',
            timestamp: '2026-01-01T00:00:00.000Z',
        });
    });

    it('sets event_type to sell for a sell event and maps fields correctly', () => {
        const event = makeTradeEvent({
            type: 'sell',
            creatorId: 'creator-2',
            buyerOrSellerAddress: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
            amount: '5',
            price: '200',
            feePaid: '2',
            timestamp: '2026-06-15T12:00:00.000Z',
        });
        const payload = buildWebhookPayload(event);

        expect(payload.event_type).toBe('sell');
        expect(payload.creator_id).toBe('creator-2');
        expect(payload.buyer_or_seller_address).toBe('GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
        expect(payload.amount).toBe('5');
        expect(payload.price).toBe('200');
        expect(payload.fee_paid).toBe('2');
        expect(payload.timestamp).toBe('2026-06-15T12:00:00.000Z');
    });

    it('produces no extra keys beyond the WebhookEventPayload contract', () => {
        const event = makeTradeEvent();
        const payload = buildWebhookPayload(event);

        const expectedKeys: Array<keyof WebhookEventPayload> = [
            'event_type',
            'creator_id',
            'buyer_or_seller_address',
            'amount',
            'price',
            'fee_paid',
            'timestamp',
        ];

        expect(Object.keys(payload).sort()).toEqual(expectedKeys.sort());
    });
});
