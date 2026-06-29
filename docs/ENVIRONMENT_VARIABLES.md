# Environment Variables Reference

Complete reference for all server configuration environment variables.

## Categories

- [Application Core](#application-core)
- [Database](#database)
- [Third-Party Services](#third-party-services)
- [Stellar Network](#stellar-network)
- [Webhooks](#webhooks)
- [Indexer](#indexer)
- [Performance & Observability](#performance--observability)
- [Background Jobs](#background-jobs)
- [Security Notes](#security-notes)

---

## Application Core

| Variable       | Type         | Required | Default         | Description                                              |
| -------------- | ------------ | -------- | --------------- | -------------------------------------------------------- |
| `PORT`         | number       | No       | `3000`          | HTTP server port                                         |
| `MODE`         | enum         | No       | `development`   | Environment mode: `development`, `production`, or `test` |
| `BACKEND_URL`  | string (URL) | Yes      | -               | Full URL where the backend is accessible                 |
| `FRONTEND_URL` | string (URL) | Yes      | -               | Full URL of the frontend application for CORS            |
| `API_VERSION`  | string       | No       | `1.0.0`         | API version string returned in response headers          |
| `APP_SECRET`   | string       | No       | _(default key)_ | Secret key for signing operations (min 32 chars)         |

---

## Database

| Variable              | Type   | Required | Default | Description                            |
| --------------------- | ------ | -------- | ------- | -------------------------------------- |
| `DATABASE_URL`        | string | Yes      | -       | PostgreSQL connection string           |
| `DB_QUERY_TIMEOUT_MS` | number | No       | `5000`  | Database query timeout in milliseconds |

---

## Third-Party Services

### Email (Gmail)

| Variable             | Type   | Required | Default | Description                      |
| -------------------- | ------ | -------- | ------- | -------------------------------- |
| `GMAIL_USER`         | string | Yes      | -       | Gmail account for sending emails |
| `GMAIL_APP_PASSWORD` | string | Yes      | -       | Gmail app-specific password      |

### Google OAuth

| Variable               | Type   | Required | Default | Description                |
| ---------------------- | ------ | -------- | ------- | -------------------------- |
| `GOOGLE_CLIENT_ID`     | string | Yes      | -       | Google OAuth client ID     |
| `GOOGLE_CLIENT_SECRET` | string | Yes      | -       | Google OAuth client secret |

### Cloudinary (Image Storage)

| Variable                | Type   | Required | Default | Description           |
| ----------------------- | ------ | -------- | ------- | --------------------- |
| `CLOUDINARY_CLOUD_NAME` | string | Yes      | -       | Cloudinary cloud name |
| `CLOUDINARY_API_KEY`    | string | Yes      | -       | Cloudinary API key    |
| `CLOUDINARY_API_SECRET` | string | Yes      | -       | Cloudinary API secret |

### Paystack (Payments)

| Variable              | Type   | Required | Default | Description                                |
| --------------------- | ------ | -------- | ------- | ------------------------------------------ |
| `PAYSTACK_SECRET_KEY` | string | Yes      | -       | Paystack secret key for payment processing |
| `PAYSTACK_PUBLIC_KEY` | string | No       | -       | Paystack public key (optional)             |

---

## Stellar Network

| Variable                  | Type         | Required | Default                               | Description                                   |
| ------------------------- | ------------ | -------- | ------------------------------------- | --------------------------------------------- |
| `STELLAR_NETWORK`         | enum         | No       | `testnet`                             | Network to connect to: `testnet` or `mainnet` |
| `STELLAR_HORIZON_URL`     | string (URL) | No       | `https://horizon-testnet.stellar.org` | Stellar Horizon API endpoint                  |
| `STELLAR_SOROBAN_RPC_URL` | string (URL) | No       | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint                          |

---

## Webhooks

| Variable                      | Type   | Required | Default | Description                                         |
| ----------------------------- | ------ | -------- | ------- | --------------------------------------------------- |
| `WEBHOOK_MAX_PER_CREATOR`     | number | No       | `5`     | Maximum active webhooks allowed per creator         |
| `WEBHOOK_RETRY_MAX_ATTEMPTS`  | number | No       | `3`     | Maximum delivery retry attempts for failed webhooks |
| `WEBHOOK_RETRY_BASE_DELAY_MS` | number | No       | `1000`  | Base delay in milliseconds between webhook retries  |

---

## Indexer

### Feature Flags

| Variable                                  | Type    | Required | Default | Description                                |
| ----------------------------------------- | ------- | -------- | ------- | ------------------------------------------ |
| `ENABLE_INDEXER_DEDUPE`                   | boolean | No       | `true`  | Enable deduplication of indexer events     |
| `ENABLE_INDEXER_DLQ`                      | boolean | No       | `true`  | Enable dead-letter queue for failed events |
| `ENABLE_INDEXER_CURSOR_STALENESS_WARNING` | boolean | No       | `true`  | Warn when indexer cursor becomes stale     |

### Tuning

| Variable                               | Type         | Required | Default  | Description                                                   |
| -------------------------------------- | ------------ | -------- | -------- | ------------------------------------------------------------- |
| `INDEXER_JITTER_FACTOR`                | number (0-1) | No       | `0.1`    | Random jitter factor for retry backoff (0.0 to 1.0)           |
| `INDEXER_CURSOR_STALE_AGE_WARNING_MS`  | number       | No       | `300000` | Milliseconds before cursor is considered stale (5 minutes)    |
| `INDEXER_HEARTBEAT_STALE_THRESHOLD_MS` | number       | No       | `300000` | Milliseconds before heartbeat is considered stale (5 minutes) |

---

## Performance & Observability

### Logging

| Variable                       | Type    | Required | Default | Description                                    |
| ------------------------------ | ------- | -------- | ------- | ---------------------------------------------- |
| `ENABLE_REQUEST_LOGGING`       | boolean | No       | `true`  | Log incoming HTTP requests                     |
| `ENABLE_RESPONSE_TIMING`       | boolean | No       | `true`  | Include response timing in logs and headers    |
| `ENABLE_API_VERSION_HEADER`    | boolean | No       | `true`  | Include `X-API-Version` header in responses    |
| `ENABLE_SCHEMA_VERSION_HEADER` | boolean | No       | `true`  | Include `X-Schema-Version` header in responses |

### Query Performance

| Variable                               | Type   | Required | Default | Description                                                    |
| -------------------------------------- | ------ | -------- | ------- | -------------------------------------------------------------- |
| `SLOW_QUERY_THRESHOLD_MS`              | number | No       | `500`   | Log queries slower than this threshold (milliseconds)          |
| `CREATOR_LIST_SLOW_QUERY_THRESHOLD_MS` | number | No       | `500`   | Threshold specifically for creator list queries (milliseconds) |

---

## Background Jobs

### Ownership Snapshot Cleanup

| Variable                                      | Type    | Required | Default                       | Description                                         |
| --------------------------------------------- | ------- | -------- | ----------------------------- | --------------------------------------------------- |
| `OWNERSHIP_SNAPSHOT_CLEANUP_ENABLED`          | boolean | No       | `false`                       | Enable automatic cleanup of old ownership snapshots |
| `OWNERSHIP_SNAPSHOT_TABLE_NAME`               | string  | No       | `creator_ownership_snapshots` | Table name for ownership snapshots                  |
| `OWNERSHIP_SNAPSHOT_RETENTION_DAYS`           | number  | No       | `30`                          | Days to retain ownership snapshots before cleanup   |
| `OWNERSHIP_SNAPSHOT_CLEANUP_DRY_RUN`          | boolean | No       | `true`                        | Run cleanup in dry-run mode (log only, no deletion) |
| `OWNERSHIP_SNAPSHOT_CLEANUP_INTERVAL_MINUTES` | number  | No       | `60`                          | Interval in minutes between cleanup job runs        |

### Job Coordination

| Variable                     | Type   | Required | Default  | Description                                        |
| ---------------------------- | ------ | -------- | -------- | -------------------------------------------------- |
| `BACKGROUND_JOB_LOCK_TTL_MS` | number | No       | `300000` | Time-to-live for distributed job locks (5 minutes) |

---

## Security Notes

### Credentials Requiring Regular Rotation

The following variables contain sensitive credentials that should be rotated regularly for security:

- **`APP_SECRET`** — Used for signing operations; rotate every 90 days
- **`GMAIL_APP_PASSWORD`** — Rotate if compromised or every 180 days
- **`GOOGLE_CLIENT_SECRET`** — Rotate if compromised
- **`CLOUDINARY_API_SECRET`** — Rotate if compromised
- **`PAYSTACK_SECRET_KEY`** — Rotate if compromised
- **`STELLAR_SOROBAN_RPC_URL`** — May contain API keys in query params; treat as sensitive

### Best Practices

- Never commit `.env` files to version control
- Use environment-specific secrets management (AWS Secrets Manager, HashiCorp Vault, etc.)
- Restrict access to production environment variables
- Audit access to secrets regularly
- Use strong, randomly-generated values for `APP_SECRET` (minimum 32 characters)

---

## Type Reference

- **string**: Text value
- **number**: Integer or decimal number
- **boolean**: `true`, `false`, `1`, or `0`
- **enum**: One of a specific set of allowed values
- **URL**: Valid HTTP/HTTPS URL format
