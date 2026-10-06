# Health and Readiness Endpoints

The health module exposes four endpoints with different contracts and intended consumers.

## Endpoints overview

| Endpoint                      | Purpose                                                      | Consumer                                  |
| ----------------------------- | ------------------------------------------------------------ | ----------------------------------------- |
| `GET /api/v1/health`          | Dependency health — probes database, Redis, and Horizon      | Load balancers, uptime monitors           |
| `GET /api/v1/health/ready`    | Readiness — confirms all critical dependencies are reachable | Kubernetes `readinessProbe`, deploy gates |
| `GET /api/v1/health/detailed` | Diagnostics — full system snapshot                           | Operators, dashboards                     |
| `GET /api/v1/health/indexer`  | Worker heartbeat — confirms the indexer is running           | Alerting, internal monitoring             |

`GET /api/v1/health` actively probes the database (a lightweight `SELECT 1`), Redis (a `PING`), and Stellar Horizon (fetching the root endpoint). It responds `200` when every dependency is reachable and `503` when any dependency is degraded, so load balancers and uptime monitors can verify end-to-end connectivity.

`GET /api/v1/health/ready` also actively pings critical dependencies. A single `fail` result flips the response to `503`, signalling to the orchestrator that this instance should stop receiving traffic until the dependency recovers.

---

## `GET /api/v1/health` — dependency health check

Probes the database, Redis, and Stellar Horizon. Returns `200` when all dependencies are healthy and `503` when any is degraded. No authentication required.

### Response shape — healthy

```json
{
   "success": true,
   "status": "ok",
   "timestamp": "2026-04-28T16:00:00.000Z",
   "checks": [
      { "name": "database", "status": "ok", "latencyMs": 3 },
      { "name": "redis", "status": "ok", "latencyMs": 1 },
      { "name": "horizon", "status": "ok", "latencyMs": 40 }
   ]
}
```

### Response shape — degraded

```json
{
   "success": false,
   "status": "degraded",
   "timestamp": "2026-04-28T16:00:00.000Z",
   "checks": [
      { "name": "database", "status": "ok", "latencyMs": 3 },
      { "name": "redis", "status": "degraded" },
      { "name": "horizon", "status": "ok", "latencyMs": 41 }
   ],
   "degraded": ["redis"]
}
```

### Fields

| Field       | Type              | Description                                                                                    |
| ----------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| `success`   | boolean           | `true` when every dependency is healthy, `false` otherwise.                                    |
| `status`    | string            | `"ok"` when all dependencies are healthy, `"degraded"` otherwise.                              |
| `timestamp` | string (ISO-8601) | When the response was built.                                                                   |
| `checks`    | array             | Per-dependency probe results. See the checks table below.                                      |
| `degraded`  | array             | Present only when degraded. Lists the names of the degraded dependencies, e.g. `["database"]`. |

#### `checks` array entry fields

| Field       | Type   | Present when                                | Description                                                                                        |
| ----------- | ------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `name`      | string | Always                                      | Dependency name. Current values: `"database"`, `"redis"`, `"horizon"`.                             |
| `status`    | string | Always                                      | `"ok"` — probe passed; `"degraded"` — probe failed.                                                |
| `latencyMs` | number | `status: "ok"` and check measured a latency | Round-trip time for this probe in milliseconds.                                                    |
| `error`     | string | `status: "degraded"`                        | Human-readable reason for the failure. No internal hostnames, connection strings, or stack traces. |

#### Probe descriptions

| Probe name | What is checked                                                        | Healthy value | Unhealthy value |
| ---------- | ---------------------------------------------------------------------- | ------------- | --------------- |
| `database` | A lightweight `SELECT 1` executes successfully.                        | `"ok"`        | `"degraded"`    |
| `redis`    | `PING` returns `PONG`. Degraded when Redis is disabled or unreachable. | `"ok"`        | `"degraded"`    |
| `horizon`  | Fetching the Horizon root endpoint returns HTTP 200.                   | `"ok"`        | `"degraded"`    |

### HTTP status codes

| Code  | Condition                                                         |
| ----- | ----------------------------------------------------------------- |
| `200` | All dependencies are healthy.                                     |
| `503` | Any dependency is degraded; the degraded dependencies are listed. |

---

## `GET /api/v1/health/ready` — readiness

Probes critical dependencies (database, cache config). Returns `200` when every probe passes and `503` otherwise.

### Response shape

```json
{
   "ready": true,
   "timestamp": "2026-04-28T16:00:00.000Z",
   "latencyMs": 7,
   "checks": [
      { "name": "database", "status": "ok", "latencyMs": 6 },
      { "name": "cache", "status": "ok" }
   ]
}
```

### Fields

| Field       | Type              | Description                                                                                                               |
| ----------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ready`     | boolean           | `true` only when every check returns `"ok"`. **This field determines the HTTP status** — `true` → `200`, `false` → `503`. |
| `timestamp` | string (ISO-8601) | When the response was built.                                                                                              |
| `latencyMs` | number            | Total wall-clock duration of the entire readiness probe in milliseconds. Useful for dashboards and SLO tracking.          |
| `checks`    | array             | Per-dependency probe results. See the checks table below.                                                                 |

#### `checks` array entry fields

| Field       | Type   | Present when                                | Description                                                                                        |
| ----------- | ------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `name`      | string | Always                                      | Dependency name. Current values: `"database"`, `"cache"`.                                          |
| `status`    | string | Always                                      | `"ok"` — probe passed; `"fail"` — probe failed.                                                    |
| `latencyMs` | number | `status: "ok"` and check measured a latency | Round-trip time for this probe in milliseconds.                                                    |
| `error`     | string | `status: "fail"`                            | Human-readable reason for the failure. No internal hostnames, connection strings, or stack traces. |

#### Probe descriptions

| Probe name | What is checked                                                       | Healthy value                | Unhealthy value            |
| ---------- | --------------------------------------------------------------------- | ---------------------------- | -------------------------- |
| `database` | Issues `SELECT 1` against the primary database.                       | `"ok"` + `latencyMs` present | `"fail"` + `error` present |
| `cache`    | Verifies that the HTTP cache layer config constant is a valid number. | `"ok"`                       | `"fail"` + `error` present |

### Non-200 trigger

The `ready` field is the sole trigger. When **any** check in the `checks` array has `status: "fail"`, `ready` is `false` and the HTTP status is `503`.

The payload is intentionally public-safe: no internal hostnames, connection strings, or stack traces are included even when a check fails.

---

## `GET /api/v1/health/detailed` — diagnostics

Full system snapshot including memory, uptime, system info, database response time, chain-sync lag, and per-service health flags. Intended for operators and dashboards — use the cheaper liveness and readiness paths for automated probing.

### Response shape

```json
{
   "success": true,
   "message": "Access Layer server is running",
   "timestamp": "2026-04-28T16:00:00.000Z",
   "version": "1.0.0",
   "environment": "production",
   "uptime": 3600.5,
   "memory": {
      "used": 48.32,
      "total": 64.0
   },
   "system": {
      "platform": "linux",
      "nodeVersion": "v20.11.0"
   },
   "timeouts": {
      "database_timeout_ms": 5000,
      "cache_timeout_ms": 300000
   },
   "database": {
      "status": "connected",
      "responseTime": 4
   },
   "syncing": {
      "status": "in-sync",
      "latestIndexedLedger": 12345,
      "observedHeadLedger": 12400,
      "syncLagLedgers": 55
   },
   "services": [
      { "name": "API Server", "status": "healthy" },
      { "name": "Database", "status": "healthy" },
      { "name": "Chain Sync", "status": "healthy" }
   ]
}
```

### Top-level fields

| Field         | Type              | Description                                                                                         |
| ------------- | ----------------- | --------------------------------------------------------------------------------------------------- |
| `success`     | boolean           | Always `true` in a normal response. `false` only on an unexpected exception.                        |
| `message`     | string            | Human-readable status string. `"Access Layer server is running"` when healthy.                      |
| `timestamp`   | string (ISO-8601) | When the response was built.                                                                        |
| `version`     | string            | Application version string.                                                                         |
| `environment` | string            | Deployment environment. Mirrors `MODE` env var (e.g. `"production"`, `"staging"`, `"development"`). |
| `uptime`      | number (seconds)  | Seconds since the Node.js process started (`process.uptime()`). Always ≥ 0.                         |
| `memory`      | object            | JVM heap snapshot. See below.                                                                       |
| `system`      | object            | Runtime identity. See below.                                                                        |
| `timeouts`    | object            | Public-safe dependency timeout values. See below.                                                   |
| `database`    | object            | Database connectivity status. See below.                                                            |
| `syncing`     | object \| absent  | Chain indexer sync lag. Absent when the sync status check itself errors.                            |
| `services`    | array             | Rolled-up health flags for each major component. See below.                                         |

### `memory` fields

| Field   | Type   | Description                                                             |
| ------- | ------ | ----------------------------------------------------------------------- |
| `used`  | number | Node.js heap memory currently used, in **megabytes** (rounded to 2 dp). |
| `total` | number | Node.js heap memory allocated, in **megabytes** (rounded to 2 dp).      |

### `system` fields

| Field         | Type   | Description                                                    |
| ------------- | ------ | -------------------------------------------------------------- |
| `platform`    | string | Operating system platform string (e.g. `"linux"`, `"darwin"`). |
| `nodeVersion` | string | Node.js version string (e.g. `"v20.11.0"`).                    |

### `timeouts` fields

Public-safe dependency timeout configuration. No connection strings, hostnames, or credentials are included.

| Field                 | Type   | Description                                        |
| --------------------- | ------ | -------------------------------------------------- |
| `database_timeout_ms` | number | Configured database query timeout in milliseconds. |
| `cache_timeout_ms`    | number | Configured public HTTP cache TTL in milliseconds.  |

### `database` fields

| Field          | Type   | Present when          | Description                                                            |
| -------------- | ------ | --------------------- | ---------------------------------------------------------------------- |
| `status`       | string | Always                | `"connected"` — `SELECT 1` succeeded; `"disconnected"` — query failed. |
| `responseTime` | number | `status: "connected"` | Round-trip time for the DB probe in milliseconds.                      |

#### Database states

| `status`         | Meaning                                     | HTTP impact                                           |
| ---------------- | ------------------------------------------- | ----------------------------------------------------- |
| `"connected"`    | Database is reachable and responding.       | Healthy.                                              |
| `"disconnected"` | Database probe threw an error or timed out. | **503** in `production`; `200` in other environments. |

### `syncing` fields

Present when the chain indexer sync status is available. Absent if the sync check itself errors.

| Field                 | Type   | Description                                                                         |
| --------------------- | ------ | ----------------------------------------------------------------------------------- |
| `status`              | string | `"in-sync"` — lag is within threshold; `"degraded"` — lag exceeds the threshold.    |
| `latestIndexedLedger` | number | Most recent ledger the indexer has processed.                                       |
| `observedHeadLedger`  | number | Latest ledger observed on the chain.                                                |
| `syncLagLedgers`      | number | Difference: `observedHeadLedger − latestIndexedLedger`. Threshold: **100 ledgers**. |

#### Sync states

| `status`     | Condition                          | `syncLagLedgers` |
| ------------ | ---------------------------------- | ---------------- |
| `"in-sync"`  | Lag is within the 100-ledger limit | 0 – 100          |
| `"degraded"` | Lag exceeds 100 ledgers            | > 100            |

The sync state does **not** affect the HTTP status code of this endpoint. Use `GET /api/v1/health/indexer` for a dedicated alerting-friendly probe.

### `services` array

A rolled-up health summary of each major component.

| `name`         | `status: "healthy"` condition                     | `status: "unhealthy"` condition       |
| -------------- | ------------------------------------------------- | ------------------------------------- |
| `"API Server"` | Always healthy (present means the server is up).  | Never unhealthy in normal operation.  |
| `"Database"`   | `database.status === "connected"`.                | `database.status === "disconnected"`. |
| `"Chain Sync"` | `syncing.status !== "degraded"` (or sync absent). | `syncing.status === "degraded"`.      |

### Non-200 trigger

`database.status === "disconnected"` **and** `environment === "production"` triggers a `503`. In non-production environments the endpoint always returns `200` regardless of database connectivity.

### Field order

The top-level JSON keys are guaranteed to appear in this order:

1. `success`
2. `message`
3. `timestamp`
4. `version`
5. `environment`
6. `uptime`
7. `memory`
8. `system`
9. `timeouts`
10.   `database`
11.   `syncing`
12.   `services`

---

## `GET /api/v1/health/indexer` — worker heartbeat

Reports the liveness state of the indexer background worker. The indexer calls `POST /api/v1/health/indexer/heartbeat` after each successful run; this endpoint exposes the resulting state.

### Response shape

```json
{
   "success": true,
   "data": {
      "service": "indexer",
      "status": "healthy",
      "lastSuccessfulRun": "2026-04-28T15:59:00.000Z",
      "staleSinceMs": null
   }
}
```

### Fields

| Field                    | Type           | Description                                                                  |
| ------------------------ | -------------- | ---------------------------------------------------------------------------- |
| `success`                | boolean        | Always `true`.                                                               |
| `data.service`           | string         | Always `"indexer"`.                                                          |
| `data.status`            | string         | Current worker state. See status table below.                                |
| `data.lastSuccessfulRun` | string \| null | ISO-8601 timestamp of the most recent heartbeat, or `null` if none recorded. |
| `data.staleSinceMs`      | number \| null | Milliseconds since the heartbeat became stale, or `null` when not stale.     |

#### Worker status values

| `data.status` | Condition                                                                             | `lastSuccessfulRun` | `staleSinceMs`  | HTTP status |
| ------------- | ------------------------------------------------------------------------------------- | ------------------- | --------------- | ----------- |
| `"unknown"`   | No heartbeat has ever been recorded (fresh deploy or restart).                        | `null`              | `null`          | `200`       |
| `"healthy"`   | Last heartbeat is within the stale threshold.                                         | ISO-8601 string     | `null`          | `200`       |
| `"degraded"`  | Last heartbeat exceeded the stale threshold (`INDEXER_HEARTBEAT_STALE_THRESHOLD_MS`). | ISO-8601 string     | positive number | `503`       |

### Non-200 trigger

`data.status === "degraded"` is the sole trigger for `503`. Both `"unknown"` and `"healthy"` return `200`.

---

## `POST /api/v1/health/indexer/heartbeat` — record worker run

Called by the indexer worker after each successful run to reset the stale timer.

### Response shape

```json
{
   "success": true,
   "data": {
      "recorded": true,
      "timestamp": "2026-04-28T16:00:00.000Z"
   },
   "message": "Heartbeat recorded"
}
```

| Field            | Type              | Description                                  |
| ---------------- | ----------------- | -------------------------------------------- |
| `success`        | boolean           | Always `true`.                               |
| `data.recorded`  | boolean           | Always `true` when the heartbeat was stored. |
| `data.timestamp` | string (ISO-8601) | The time the heartbeat was recorded.         |
| `message`        | string            | Always `"Heartbeat recorded"`.               |
