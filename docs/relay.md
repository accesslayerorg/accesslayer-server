# Signed transaction relay

`GET /relay/nonce/:wallet` reserves the wallet's next Stellar account sequence
for five minutes. Repeated reads return the active reservation without extending
its expiry. The wallet must be a valid Ed25519 public key and exist on the
configured network. Nonces are decimal **strings**, preserving 64-bit precision.

```json
{ "wallet": "G...", "nonce": "12345678901234567" }
```

`POST /relay/submit` accepts:

```json
{
   "wallet": "G...",
   "nonce": "12345678901234567",
   "signature": "base64 Ed25519 signature over the inner transaction hash",
   "tx_params": "base64 transaction-envelope XDR"
}
```

The network passphrase follows `STELLAR_NETWORK`. The transaction source and
sequence must match the wallet and reservation. The detached wallet signature
must verify before any submission. Standard envelopes receive that signature
if absent. For gasless transactions, callers supply a fully sponsored fee-bump
envelope: sign the inner transaction with the wallet **before** wrapping and
signing with the fee sponsor. The embedded wallet signature must match the
detached signature; the relay preserves the envelope to avoid invalidating the
sponsor signature. This endpoint does not generate or store a sponsor secret.

Both endpoints share a rolling limit of 10 requests per wallet per minute,
including rejected submissions. Redis is required (`ENABLE_REDIS_CACHE=true`);
unavailability fails closed with `503`. Atomic Redis claims prevent concurrent
submissions. Submission uses the existing contract service for retries,
transaction persistence, confirmation polling, and resolution events, with
operation `relay`. Success returns `200` and `{"tx_hash":"..."}` after confirmation.
The next nonce becomes available once Horizon observes the prior sequence.

Failures return `{"error":"..."}`: `400` invalid payload/XDR or source/sequence
mismatch; `401` invalid signature; `404` wallet not found; `409` expired, claimed,
or pending reservation; `429` wallet rate limit; `502` upstream/relay failure;
`503` unavailable infrastructure. Relay failures may include
`details: {tx_hash, error_kind}`; raw provider errors are not returned.

Failed or uncertain submissions remain claimed until their five-minute claim
expires. Reconcile any returned hash before retrying: a timeout does not prove
that the network rejected a transaction. Chain sequence validation remains the
durable replay boundary; Redis reservations are not authorization to bypass it.

Offline HTTP tests cover reservation expiry, signature verification, replay,
concurrency, sponsored envelopes, and wallet rate limits:

```bash
pnpm test --runInBand --testPathPatterns=relay
```

These tests mock Redis and the contract-service boundary. They do not exercise a
live Redis server, funded wallet, or deployed Soroban RPC.
