# Live swap updates

The API server exposes a WebSocket endpoint at `/ws` for live bonding-curve
trade updates. Clients can subscribe to one or more creator key IDs:

```json
{ "type": "subscribe", "key_id": "creator-key-id" }
```

The server replies with `{"type":"subscribed","key_id":"creator-key-id"}`.
Sending the same subscription more than once is safe. A client can remove a
subscription with `{"type":"unsubscribe","key_id":"creator-key-id"}`.
Each connection can subscribe to at most 100 keys.

After an indexed `KEY_BOUGHT` or `KEY_SOLD` event is persisted, subscribers to
that key receive:

```json
{
   "type": "swap_event",
   "key_id": "creator-key-id",
   "price": "12000000",
   "amount": "2",
   "direction": "buy",
   "timestamp": "2026-10-18T12:00:00.000Z"
}
```

`price` is the unit bonding-curve price in stroops. Price and amount are strings
to avoid losing integer precision. `direction` is `buy` or `sell`, and the
timestamp is the indexed event time in ISO 8601 format. Updates are sent only
to clients subscribed to the matching `key_id`.

The server sends a WebSocket ping every 30 seconds. Clients that miss a pong
are disconnected on the next heartbeat, and their subscriptions are removed.
Reconnects start with no subscriptions, so clients should subscribe again after
opening a new connection.
