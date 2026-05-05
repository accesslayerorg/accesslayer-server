# API Timeout Configuration

Timeout values control how long the server waits before treating an operation as failed.
All values are in milliseconds unless noted.

## Defaults

| Config key | Default | Source | Description |
|---|---|---|---|
| `RPC_TIMEOUT_MS` (code constant) | `5000` | `src/utils/rpc-timeout.utils.ts` | Max wait for outbound RPC calls. Per-call override via `withRpcTimeout` third arg. |
| `BACKGROUND_JOB_LOCK_TTL_MS` | `300000` | `src/config.ts`, `.env` | How long a background job holds its distributed lock before it is considered stale. |
| `SHUTDOWN_TIMEOUT_MS` (code constant) | `30000` | `src/server.ts` | Hard deadline for graceful shutdown before `process.exit(1)` is forced. |
| `DRAIN_WINDOW_MS` (code constant) | `5000` | `src/server.ts` | Extra drain period after the HTTP server closes to finish in-flight requests. |

## Override examples

### Development (`.env`)

```env
# Loosen job lock TTL for slow local machines
BACKGROUND_JOB_LOCK_TTL_MS=600000
```

### Production (`.env` or environment injection)

```env
# Tighten job lock TTL for fast infra with reliable workers
BACKGROUND_JOB_LOCK_TTL_MS=120000
```

### Per-call RPC override (code)

`DEFAULT_RPC_TIMEOUT_MS` and `SHUTDOWN_TIMEOUT_MS` / `DRAIN_WINDOW_MS` are compile-time
constants, not environment variables. Override at the call site:

```ts
import { withRpcTimeout } from '../utils/rpc-timeout.utils';

// default 5 000 ms
const data = await withRpcTimeout('fetchUser', () => api.getUser(id));

// explicit override for a known-slow operation
const report = await withRpcTimeout('generateReport', () => api.report(), 15_000);
```

To change the process-wide defaults, edit the constants directly in their source files and redeploy.
