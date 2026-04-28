# Protocol Config Endpoint

## Overview

`GET /api/v1/config` returns a read-only bootstrap payload clients fetch once on startup. No authentication required.

## Response shape

```json
{
  "success": true,
  "data": {
    "environment": "development",
    "apiVersion": "v1",
    "network": "testnet",
    "features": {
      "walletConnect": true,
      "emailVerification": true,
      "googleOAuth": true
    },
    "display": {
      "appName": "AccessLayer",
      "supportEmail": "support@accesslayer.org"
    },
    "fees": {
      "platformFeeBps": 250,
      "maxCreatorRoyaltyBps": 1000,
      "bpsDenominator": 10000
    }
  }
}
```

## Basis points (bps) fields

All values inside `fees` are expressed in **basis points**.

| 1 bps | 0.01% |
|-------|-------|
| 100 bps | 1% |
| 10000 bps | 100% |

Valid range for all bps fields: **0 – 10000** (inclusive).

To convert to a percentage:

```
percent = (feeBps / bpsDenominator) * 100
```

### `platformFeeBps`

Platform fee applied to every key purchase. Set by the protocol; clients must treat it as read-only.

- Default: `250` (2.50%)
- Range: 0–10000

### `maxCreatorRoyaltyBps`

Ceiling for creator-configured royalties on secondary sales. Creators may set any royalty up to this value; the contract rejects values above it.

- Default: `1000` (10.00%)
- Range: 0–10000

### `bpsDenominator`

Always `10000`. Exposed explicitly so clients can derive percentages without hardcoding the divisor.

## Usage example

```ts
const { fees } = await fetchProtocolConfig();
const platformFeePercent = (fees.platformFeeBps / fees.bpsDenominator) * 100;
// 2.5
```

## Validation locally

```bash
curl http://localhost:3000/api/v1/config | jq '.data.fees'
```

Expected:

```json
{
  "platformFeeBps": 250,
  "maxCreatorRoyaltyBps": 1000,
  "bpsDenominator": 10000
}
```
