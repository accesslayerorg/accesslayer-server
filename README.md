# Access Layer Server

This repository contains the backend API for Access Layer.

The server is the off-chain layer for the product. It handles the parts of the marketplace that do not need to live inside Stellar smart contracts, while coordinating with the client and contracts as the product grows.

## Purpose

The server is responsible for:

- creator and user profile management
- auth and session-related flows
- creator metadata and perk definitions
- indexing contract activity for faster reads
- notifications, analytics, and moderation workflows
- access checks for gated off-chain content

See [Backend Domain Model and Endpoint Boundaries](./docs/architecture/domain-boundaries.md) for a technical overview and [API Versioning](./docs/api-versioning.md) for details on schema versioning.

## Tech

- Node.js
- Express
- TypeScript
- Prisma
- PostgreSQL

## Current state

- Express app bootstrap exists in [src/app.ts](./src/app.ts)
- common backend middleware is already scaffolded
- reusable starter utilities are kept in generic Access Layer-safe form

## Local setup

```bash
pnpm install
cp .env.example .env
pnpm db:up
pnpm exec prisma generate
pnpm exec prisma db push
pnpm dev
```

## Database

This repo includes a local PostgreSQL container for development.

Start the database:

```bash
pnpm db:up
```

Watch database logs:

```bash
pnpm db:logs
```

Stop the database:

```bash
pnpm db:down
```

The default connection string in `.env.example` matches the included Docker setup.

## Verification

```bash
pnpm lint
pnpm build
```

## Health Check

The server provides health check endpoints for local development and production monitoring:

### Simple Health Check

**Endpoint:** `GET /api/v1/health`

Returns a minimal response suitable for load balancers and uptime monitors:

```json
{
   "success": true,
   "message": "OK",
   "timestamp": "2025-01-15T10:30:00.000Z"
}
```

### Detailed Health Check

**Endpoint:** `GET /api/v1/health/detailed`

Returns comprehensive service status including database connectivity:

```json
{
   "success": true,
   "message": "Access Layer server is running",
   "timestamp": "2025-01-15T10:30:00.000Z",
   "version": "1.0.0",
   "environment": "development",
   "uptime": 12345.67,
   "memory": {
      "used": 45.23,
      "total": 128.5
   },
   "system": {
      "platform": "win32",
      "nodeVersion": "v20.10.0"
   },
   "database": {
      "status": "connected",
      "responseTime": 12
   },
   "services": [
      {
         "name": "API Server",
         "status": "healthy"
      },
      {
         "name": "Database",
         "status": "healthy"
      }
   ]
}
```

**Response Codes:**

- `200 OK` - All services healthy (or development mode)
- `503 Service Unavailable` - Database disconnected in production

### Usage Examples

**Local Development:**

```bash
curl http://localhost:3000/api/v1/health/detailed
```

**Production Monitoring:**

```bash
curl https://your-domain.com/api/v1/health
```

**Docker/Kubernetes Health Probes:**

```yaml
livenessProbe:
   httpGet:
      path: /api/v1/health
      port: 3000
   initialDelaySeconds: 10
   periodSeconds: 30

readinessProbe:
   httpGet:
      path: /api/v1/health/detailed
      port: 3000
   initialDelaySeconds: 5
   periodSeconds: 10
```

## Open source workflow

- Read the [README](./README.md) for context.
- Review the [Backend Domain Model and Endpoint Boundaries](./docs/architecture/domain-boundaries.md).
- Review the scoped backlog in [docs/open-source/issue-backlog.md](./docs/open-source/issue-backlog.md).
- Review [SECURITY.md](./SECURITY.md) before reporting vulnerabilities.
- Use the issue templates in [`.github/ISSUE_TEMPLATE`](./.github/ISSUE_TEMPLATE) for new scoped work.
