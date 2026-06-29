# Trade Webhooks Integration and Delivery Guarantees

AccessLayer supports trade webhooks to notify external creators and integrations in real time when key trades (buys or sells) occur for a creator profile.

---

## 1. Webhook Management API

To register, view, or delete webhooks, creators must authenticate using Stellar wallet signature headers.

### Base Headers for Signed Creator Requests

All management requests require the following headers for wallet verification:

- `x-wallet-address`: The Stellar public key (G...) of the creator's wallet.
- `x-signature`: A Base64-encoded signature of the request payload, verifying wallet ownership.
- `x-timestamp`: The Unix timestamp (in milliseconds) when the signature was generated. The signature is rejected if this timestamp is older than 5 minutes.

### Register a Webhook

- **Method:** `POST`
- **Path:** `/api/v1/creators/:id/webhooks`
- **Request Body (JSON):**
   ```json
   {
      "callback_url": "https://your-domain.com/webhooks/trade-handler",
      "events": ["buy", "sell"]
   }
   ```
- **Response (201 Created):**
   ```json
   {
      "success": true,
      "data": {
         "id": "cm1a2b3c4d0000z9y8x7w6v5u4",
         "creatorId": "webhook-test-creator-id",
         "callbackUrl": "https://your-domain.com/webhooks/trade-handler",
         "events": ["buy", "sell"],
         "isActive": true,
         "isFailing": false,
         "createdAt": "2026-06-23T04:00:00.000Z",
         "updatedAt": "2026-06-23T04:00:00.000Z"
      },
      "message": "Webhook registered successfully"
   }
   ```

### List Webhooks

- **Method:** `GET`
- **Path:** `/api/v1/creators/:id/webhooks`
- **Response (200 OK):**
   ```json
   {
      "success": true,
      "data": [
         {
            "id": "cm1a2b3c4d0000z9y8x7w6v5u4",
            "creatorId": "webhook-test-creator-id",
            "callbackUrl": "https://your-domain.com/webhooks/trade-handler",
            "events": ["buy", "sell"],
            "isActive": true,
            "isFailing": false,
            "createdAt": "2026-06-23T04:00:00.000Z",
            "updatedAt": "2026-06-23T04:00:00.000Z"
         }
      ]
   }
   ```

### Delete a Webhook

- **Method:** `DELETE`
- **Path:** `/api/v1/creators/:id/webhooks/:webhookId`
- **Response (200 OK):**
   ```json
   {
      "success": true,
      "data": {
         "id": "cm1a2b3c4d0000z9y8x7w6v5u4"
      },
      "message": "Webhook deleted successfully"
   }
   ```

---

## 2. Webhook Event Payload

When a trade occurs, AccessLayer sends an HTTP `POST` request containing a JSON body to the registered `callback_url`.

### Payload Fields

| Field Name                | Type     | Description                                                                 | Example Value                |
| :------------------------ | :------- | :-------------------------------------------------------------------------- | :--------------------------- |
| `event_type`              | `string` | The type of trade event (`"buy"` or `"sell"`).                              | `"buy"`                      |
| `creator_id`              | `string` | The Stellar public key or identifier of the creator whose keys were traded. | `"GCSW65D4G56DF...2XDF"`     |
| `buyer_or_seller_address` | `string` | The Stellar public key of the trader's wallet executing the transaction.    | `"GDD3DDK4J5H5D...8LKF"`     |
| `amount`                  | `string` | The amount of keys traded (decimal representation).                         | `"1.0000000"`                |
| `price`                   | `string` | The price per key in XLM (decimal representation).                          | `"15.5000000"`               |
| `fee_paid`                | `string` | The protocol/creator fee paid for this trade in XLM.                        | `"0.4650000"`                |
| `timestamp`               | `string` | The ISO 8601 UTC timestamp of the trade event transaction.                  | `"2026-06-23T04:00:00.000Z"` |

### Example Payload

```json
{
   "event_type": "buy",
   "creator_id": "GCSW65D4G56DF8B2N7M9L3K4J2XDF",
   "buyer_or_seller_address": "GDD3DDK4J5H5D9S8A7P6O5I4U8LKF",
   "amount": "100.0000000",
   "price": "10.5000000",
   "fee_paid": "0.5000000",
   "timestamp": "2026-06-23T04:00:00.000Z"
}
```

---

## 3. Delivery Guarantees & Ordering

Integrators should be aware of the following delivery characteristics when handling webhooks:

### At-Least-Once Delivery

AccessLayer guarantees that all matching trade events are delivered **at least once** to your callback URL. However, under certain conditions (such as network hiccups, database latency, or retries), the same event might be sent multiple times.

> [!TIP]
> **Idempotency Handling:** Webhook consumers should check if an event has already been processed before taking action. Since event payloads do not currently include a unique event UUID, consumers can construct an idempotency key using a hash or combination of `timestamp`, `buyer_or_seller_address`, `amount`, and `price`.

### Delivery Ordering

Because webhook deliveries are handled asynchronously and retry delays can occur on a per-event basis, **delivery order is not strictly guaranteed**.

> [!IMPORTANT]
> **Event Chronology:** Consumers should inspect the `timestamp` field in the webhook payload to determine the actual chronological sequence of trade events, rather than relying on the order of HTTP request arrivals.

---

## 4. Retry and Failure Behavior

If a delivery attempt fails, AccessLayer retries the delivery using an exponential backoff schedule.

- **Request Timeout:** Each delivery request attempt has a hard timeout of **5 seconds**.
- **Maximum Attempts:** AccessLayer will attempt delivery up to **3 times** (the original dispatch plus 2 retries).
- **Exponential Backoff:** The delay before retrying increases exponentially with each failed attempt, using the formula:
  $$\text{delay (ms)} = 2^{\text{attempt}} \times 1000$$
   - **Attempt 1 (Original):** Dispatched immediately.
   - **Attempt 2 (Retry 1):** Delays **2 seconds** after Attempt 1 fails.
   - **Attempt 3 (Retry 2):** Delays **4 seconds** after Attempt 2 fails.
- **Exhaustion & Failure Flagging:**
   - If all 3 attempts fail, the event status is updated to `FAILED` in the database, and the error description is stored in `lastError`.
   - The parent webhook registration is updated with `isFailing = true`.
   - **Suspension:** While a webhook is flagged as failing, future events will not be dispatched to it. This prevents unnecessary traffic to dead endpoints. Creators must delete and recreate the webhook (or update its status once the endpoint is resolved) to resume dispatches.

---

## 5. Request Verification (Signature)

Creators should verify every incoming webhook before processing the payload. Verification confirms that the request was produced by AccessLayer and that the request body was not modified in transit.

### Signature Headers

AccessLayer includes the following headers on each outgoing webhook `POST` request:

| Header                    | Description                                                              |
| :------------------------ | :----------------------------------------------------------------------- |
| `x-accesslayer-signature` | Hex-encoded HMAC digest for the request.                                 |
| `x-accesslayer-timestamp` | Unix timestamp in milliseconds when AccessLayer generated the signature. |

### Signing Algorithm and Signed Content

AccessLayer computes the signature with **HMAC-SHA256** using the webhook signing secret associated with the webhook registration.

The signed message is the exact timestamp header value, a period (`.`), and the exact raw HTTP request body bytes:

```text
<x-accesslayer-timestamp>.<raw-request-body>
```

For example, if the timestamp header is `1782705600000`, the HMAC input is:

```text
1782705600000.{"event_type":"buy","creator_id":"GCSW...","amount":"100.0000000"}
```

> [!IMPORTANT]
> Use the raw request body exactly as received on the wire. Do not parse and re-serialize JSON before verification, because whitespace or property-order changes will produce a different HMAC.

### Step-by-Step Verification Guide

1. Read `x-accesslayer-signature` and `x-accesslayer-timestamp` from the request headers.
2. Reject the request if either header is missing.
3. Parse `x-accesslayer-timestamp` as a Unix timestamp in milliseconds.
4. Reject the request if the timestamp is outside the allowed replay window. AccessLayer recommends accepting signatures only when the timestamp is within **5 minutes** of your server time.
5. Build the signed message as `timestamp + "." + rawBody`.
6. Compute `HMAC-SHA256(signedMessage, webhookSigningSecret)` and encode the digest as lowercase hexadecimal.
7. Compare the computed digest with `x-accesslayer-signature` using a constant-time comparison function.
8. Process the webhook only after both the timestamp and signature checks pass.

### Pseudocode Example

```pseudo
function handleAccessLayerWebhook(request):
  signature = request.header("x-accesslayer-signature")
  timestamp = request.header("x-accesslayer-timestamp")
  rawBody = request.rawBody

  if signature is missing or timestamp is missing:
    return response(status = 400)

  timestampMs = parseInteger(timestamp)
  nowMs = currentUnixTimeMilliseconds()

  if timestampMs is invalid:
    return response(status = 400)

  if absoluteValue(nowMs - timestampMs) > 5 minutes:
    return response(status = 400)

  signedMessage = timestamp + "." + rawBody
  expectedSignature = hex(hmacSha256(secret = webhookSigningSecret, message = signedMessage))

  if not constantTimeEquals(expectedSignature, signature):
    return response(status = 400)

  processWebhook(JSON.parse(rawBody))
  return response(status = 200)
```

### Replay Attack Protection

The timestamp header is part of the signed message, so a third party cannot change it without invalidating the signature. Consumers should reject any request whose `x-accesslayer-timestamp` is more than **5 minutes** in the past or future relative to their server clock. This limits the time window in which a captured valid request can be replayed.

For additional protection, consumers may store recently seen signatures or idempotency keys for the same 5-minute window and reject duplicates. This duplicate check is optional but recommended for high-risk integrations.

### Verification Failures

If any verification step fails, return **HTTP 400 Bad Request** and do **not** process the payload. Do not partially process failed requests, enqueue background work for them, or treat them as successful deliveries.
