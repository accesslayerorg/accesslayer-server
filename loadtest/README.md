# k6 Performance & Load Testing

This directory contains automated k6 performance and load testing suites for the Access Layer API. These tests establish performance baselines and enforce latency and error budgets in CI to prevent performance regressions from reaching production.

## Target Endpoints

The load test suite targets the highest-throughput endpoints across read and write operations:

| Method | Endpoint                        | Type  | Description                                                 |
| ------ | ------------------------------- | ----- | ----------------------------------------------------------- |
| `GET`  | `/v1/keys`                      | Read  | Paginated listing of creator keys with query filters        |
| `GET`  | `/v1/keys/:id`                  | Read  | Detailed profile for an individual creator key              |
| `GET`  | `/v1/wallets/:address/holdings` | Read  | Portfolio key holdings for a given Stellar wallet address   |
| `POST` | `/v1/orders`                    | Write | Authenticated order placement updating ownership and trades |

## Performance Thresholds & Budgets

The suite enforces strict performance budgets matching production service-level objectives:

- **Read Routes (`GET`)**:
   - `p95 < 300ms` (95th percentile response time strictly under 300 milliseconds)
   - `http_req_failed < 1%` (error rate under 1.0%)
- **Write Routes (`POST`)**:
   - `p95 < 600ms` (95th percentile response time strictly under 600 milliseconds)
   - `http_req_failed < 1%` (error rate under 1.0%)
- **Overall Sanity**:
   - `checks > 99%` (over 99% of all assertions must pass)

Any breach of these thresholds results in a non-zero exit code (`exit 99` by k6), immediately failing the pull request in GitHub Actions CI.

## Directory Structure

```
loadtest/
├── lib/
│   └── auth.js             # Generates signed wallet sessions (JWT access tokens & headers)
├── keys-list.js            # Scenario for GET /v1/keys
├── keys-detail.js          # Scenario for GET /v1/keys/:id
├── wallet-holdings.js       # Scenario for GET /v1/wallets/:address/holdings
├── orders.js               # Scenario for POST /v1/orders
├── smoke.js                # Combined 60-second multi-scenario smoke profile (used in CI)
├── soak.js                 # Local sustained soak testing profile
├── seed.ts                 # Database seed script (10,000 keys, 100,000 trades)
└── README.md               # Documentation and execution guide
```

## Authentication

Authenticated routes (such as `POST /v1/orders`) require a valid wallet session. The `loadtest/lib/auth.js` module generates signed HMAC-SHA256 JWT tokens bound to a target Stellar wallet address:

```javascript
import { getAuthHeaders } from './lib/auth.js';

const headers = getAuthHeaders(
   'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR'
);
// Returns: { Authorization: 'Bearer <signed_jwt>', 'x-wallet-address': '...', 'Content-Type': 'application/json' }
```

The tokens are verified server-side via `requireJwtAuth` against `JWT_SECRET`.

## Seeding Test Data

Before executing load tests, populate the database with realistic high-volume data:

```bash
# Seed 10,000 creator keys, 100,000 trades, and test wallet holdings
pnpm run loadtest:seed
# or
npm run loadtest:seed
```

### Idempotency

`loadtest/seed.ts` is fully idempotent. If run multiple times, it detects existing data and skips re-insertion without modifying existing records or failing unique constraints.

## Running the Smoke Profile

The smoke profile runs all 4 scenarios concurrently for 60 seconds against a running stack:

```bash
# Ensure server is running on localhost:3000
npm run loadtest:smoke
# or
pnpm run loadtest:smoke
```

This exports `loadtest-summary.json` containing detailed execution metrics, percentiles, and threshold outcomes.

## Running Individual Scenarios

You can also run scenarios individually for focused debugging:

```bash
# Test GET /v1/keys
k6 run loadtest/keys-list.js

# Test GET /v1/keys/:id
k6 run loadtest/keys-detail.js

# Test GET /v1/wallets/:address/holdings
k6 run loadtest/wallet-holdings.js

# Test POST /v1/orders
k6 run loadtest/orders.js
```

Override default parameters via environment variables:

```bash
k6 run -e BASE_URL=http://localhost:3000 -e KEY_ID=seed-key-00042 loadtest/keys-detail.js
```

## Running the Soak Profile Locally

Soak testing validates server stability, database connection pooling, and memory consumption under steady load over extended durations.

To run the soak profile:

```bash
# Run the default 30-minute soak test
k6 run loadtest/soak.js

# Run with custom duration (e.g., 1 hour)
k6 run -e SOAK_DURATION=1h loadtest/soak.js

# Run with custom virtual users (VUs) and duration
k6 run --vus 25 --duration 2h loadtest/soak.js
```

### What to Monitor During Soak Tests

1. **Memory**: Node.js heap usage should stabilize after ramp-up and not exhibit monotonic growth.
2. **Database Connections**: PostgreSQL active connections should remain bounded within `DB_POOL_MAX`.
3. **Response Times**: p95 latencies must remain within `< 300ms` (reads) and `< 600ms` (writes) without degradation over time.

## CI Workflow Integration

Pull requests trigger the `loadtest` job in `.github/workflows/ci.yml`:

1. Launches disposable PostgreSQL and Redis containers.
2. Pushes Prisma schema and runs `loadtest/seed.ts` twice to verify idempotency.
3. Builds and boots the application server.
4. Executes `pnpm run loadtest:smoke` (60s smoke profile).
5. Uploads `loadtest-summary.json` as a GitHub Actions artifact for inspection on both success and failure.
