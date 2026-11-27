# Logging and PII Scrubbing

Every log line, error report and analytics payload passes through one scrub layer
before it leaves the process. The rules live in [`src/lib/scrub.ts`](../src/lib/scrub.ts).

## What is removed

| Kind | Example input | Output |
| --- | --- | --- |
| Sensitive field names (any depth, any case, `-`/`_` ignored) | `{ "apiKey": "…" }`, `{ "Set-Cookie": "…" }` | `"[REDACTED]"` |
| Email addresses in strings | `jane@example.com` | `[REDACTED:email]` |
| Bearer tokens | `Bearer abc.def` | `Bearer [REDACTED:token]` |
| JWTs | `eyJhbGciOi…` | `[REDACTED:jwt]` |
| Provider API keys | `sk_live_…`, `pk_test_…` | `[REDACTED:api-key]` |
| Inline secrets | `api_key=abc123` | `api_key=[REDACTED:secret]` |
| Stellar secret seeds (`S…`) | `SC…` | `[REDACTED:seed]` |
| Stellar wallet addresses (`G…`) | `GABC…` | `wallet_` + 16 hex chars (see below) |

Default sensitive field names are in `DEFAULT_SENSITIVE_FIELDS`. Add deployment-specific
names with `SCRUB_EXTRA_FIELDS` (comma-separated), for example `SCRUB_EXTRA_FIELDS=vatNumber,shippingCode`.

## Wallet addresses

Wallet addresses are hashed, not dropped, because support and fraud review often need to
correlate events for one wallet:

- The hash key is `HMAC(secret, "wallet-salt:<period>")`, where the period is the current salt
  rotation window (`SCRUB_WALLET_SALT_ROTATION_DAYS`, default 7).
- Within one period the same wallet always hashes to the same value.
- Across periods the same wallet hashes differently, so logs from different periods cannot be joined.
- Set `SCRUB_WALLET_HASH_SECRET` in production. Without it the key is random per process, so
  hashes only correlate within one process lifetime.

## Where the rules apply

| Integration | Entry point | Status |
| --- | --- | --- |
| Application logger (pino) | `hooks.logMethod` in [`src/utils/logger.utils.ts`](../src/utils/logger.utils.ts) scrubs the message and every field | Active |
| Ad-hoc pino keys | `createScrubSerializer(rules)` | Available |
| Sentry `beforeSend` | `createSentryBeforeSend(rules)` drops `user`, removes request cookies, scrubs the rest | Ready. The Sentry SDK is not a dependency yet |

Scrubbing works on a deep copy. The original object is never mutated.

## Log linter

[`src/lib/log-linter.ts`](../src/lib/log-linter.ts) scans serialised log lines for the same
patterns, plus unredacted secret-named JSON fields and raw wallet addresses. The test
[`src/lib/log-linter.test.ts`](../src/lib/log-linter.test.ts) runs real pino output through the
scrub hooks and fails if anything is left behind. Linter reports never echo a full secret.

## Review checklist for new logs

When you add a `logger.*` call or an error report:

1. Log identifiers (`creatorId`, `shardIndex`, request ids), not values that identify people
   or grant access.
2. Do not log request bodies, headers or query strings wholesale. Pick the fields you need.
3. Do not log `passwordHash`, tokens, cookies, seeds or signed payloads. These are redacted
   anyway, but do not rely on the redaction to make a mistake safe.
4. If you add a new field name that carries personal or secret data, add it to
   `SCRUB_EXTRA_FIELDS` in the deployment, or to `DEFAULT_SENSITIVE_FIELDS` in code.
5. Run `pnpm test -- src/lib` before opening the pull request.

## Related

- [Environment variables](./ENVIRONMENT_VARIABLES.md#logging)
- [Sensitive field masking](../src/utils/mask-sensitive.utils.ts) and [config masking](../src/utils/config-mask.utils.ts) cover other log-shape concerns.
