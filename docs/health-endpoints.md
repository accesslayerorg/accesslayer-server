# Health and Readiness Endpoints

The health module exposes three endpoints, each with a different contract.

## `GET /api/v1/health` — liveness

A minimal "the process is up" check. Always `200` while the event loop is
healthy. Safe for load balancers and uptime monitors that should not fan out
to dependencies.

## `GET /api/v1/health/ready` — readiness

Probes critical dependencies (database, cache config). Returns `200` when
every probe passes and `503` otherwise.

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

| Field       | Type              | Notes                                                                                                                                          |
| ----------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`     | boolean           | `true` only when every check is `ok`. Maps directly to the HTTP status (`200` vs `503`).                                                       |
| `timestamp` | string (ISO-8601) | When the response was built.                                                                                                                   |
| `latencyMs` | number            | **Total** wall-clock duration of the readiness probe — sum of every check plus orchestration overhead. Useful for dashboards and SLO tracking. |
| `checks`    | array             | Per-dependency results, each with its own `name`, `status`, optional `latencyMs`, and optional `error`.                                        |

The payload is intentionally public-safe: no internal hostnames,
connection strings, or stack traces are included even when a check fails.

## `GET /api/v1/health/detailed` — diagnostics

Full system snapshot including memory, uptime, system info, database
response time, chain-sync lag and per-service health flags. Intended for
operators rather than load balancers — cheaper liveness/readiness paths
should be preferred for automated probing.
