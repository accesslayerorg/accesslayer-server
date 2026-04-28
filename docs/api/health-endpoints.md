# Health Endpoints API Documentation

## Overview

The Access Layer server provides three health endpoints for monitoring system status and dependency health:

- `GET /health` - Simple liveness check
- `GET /health/ready` - Readiness check with critical dependencies
- `GET /health/detailed` - Full health diagnostics including timeout metadata

## Endpoints

### 1. Simple Health Check

**Endpoint:** `GET /health`

**Description:** Basic liveness check for load balancers. Returns minimal response without dependency probing.

**Response:**
```json
{
  "success": true,
  "message": "OK",
  "timestamp": "2024-04-28T18:00:00.000Z"
}
```

### 2. Readiness Check

**Endpoint:** `GET /health/ready`

**Description:** Checks critical dependencies (database, cache configuration). Returns 503 if any critical dependency is unavailable.

**Response:**
```json
{
  "ready": true,
  "timestamp": "2024-04-28T18:00:00.000Z",
  "checks": [
    {
      "name": "database",
      "status": "ok",
      "latencyMs": 15
    },
    {
      "name": "cache",
      "status": "ok"
    }
  ]
}
```

### 3. Detailed Health Check

**Endpoint:** `GET /health/detailed`

**Description:** Comprehensive health diagnostics including system metrics, database status, sync status, and dependency timeout settings.

**Response:**
```json
{
  "success": true,
  "message": "Access Layer server is running",
  "timestamp": "2024-04-28T18:00:00.000Z",
  "version": "1.0.0",
  "environment": "production",
  "uptime": 3600.5,
  "memory": {
    "used": 125.75,
    "total": 256.0
  },
  "system": {
    "platform": "linux",
    "nodeVersion": "v18.17.0"
  },
  "database": {
    "status": "connected",
    "responseTime": 15
  },
  "syncing": {
    "status": "in-sync",
    "latestIndexedLedger": 12345,
    "observedHeadLedger": 12400,
    "syncLagLedgers": 55
  },
  "services": [
    {
      "name": "API Server",
      "status": "healthy"
    },
    {
      "name": "Database",
      "status": "healthy"
    },
    {
      "name": "Chain Sync",
      "status": "healthy"
    }
  ],
  "timeouts": {
    "rpc": 5000,
    "backgroundJob": 300000,
    "slowQueryThreshold": 500,
    "shutdown": 30000
  }
}
```

## Timeout Metadata Fields

The `timeouts` object in the detailed health response contains the following dependency timeout settings:

| Field | Type | Description | Default |
|-------|------|-------------|---------|
| `rpc` | number | Default timeout for outbound RPC calls in milliseconds | 5000 |
| `backgroundJob` | number | TTL for background job locks in milliseconds | 300000 |
| `slowQueryThreshold` | number | Threshold for slow query detection in milliseconds | 500 |
| `shutdown` | number | Graceful shutdown timeout in milliseconds | 30000 |

### Security Considerations

- **Development Environment**: Exact timeout values are exposed
- **Production Environment**: Values are rounded to avoid exposing precise configurations:
  - `rpc`: Rounded to nearest second
  - `backgroundJob`: Rounded to nearest minute
  - `slowQueryThreshold`: Rounded to nearest 100ms
  - `shutdown`: Rounded to nearest 5 seconds

## HTTP Status Codes

- **200**: Service is healthy
- **503**: Service is unhealthy or critical dependencies are unavailable
- **500**: Health check failed due to internal error

## Monitoring Integration

### Prometheus Metrics

The health endpoints can be used with monitoring tools like Prometheus:

```yaml
# Example Prometheus configuration
scrape_configs:
  - job_name: 'accesslayer-health'
    static_configs:
      - targets: ['localhost:3000']
    metrics_path: '/health/detailed'
    scrape_interval: 30s
```

### Kubernetes Liveness/Readiness Probes

```yaml
# Example Kubernetes deployment configuration
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 30
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /health/ready
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 5
```

## Troubleshooting

### Common Issues

1. **Database Connection Failed**
   - Check `database.status` field
   - Verify `DATABASE_URL` environment variable
   - Ensure database is accessible

2. **High Memory Usage**
   - Monitor `memory.used` vs `memory.total`
   - Check for memory leaks in application logs

3. **Chain Sync Degraded**
   - Check `syncing.status` field
   - Monitor `syncLagLedgers` value
   - Verify indexer connectivity

4. **Timeout Configuration Issues**
   - Review `timeouts` object for current settings
   - Compare with environment variable configurations
   - Ensure values are appropriate for your deployment environment

## Environment Variables

The following environment variables affect timeout behavior:

- `BACKGROUND_JOB_LOCK_TTL_MS`: Background job lock timeout (default: 300000)
- `CREATOR_LIST_SLOW_QUERY_THRESHOLD_MS`: Slow query threshold (default: 500)

RPC and shutdown timeouts are configured in code:
- `DEFAULT_RPC_TIMEOUT_MS`: RPC call timeout (5000ms)
- `SHUTDOWN_TIMEOUT_MS`: Graceful shutdown timeout (30000ms)
