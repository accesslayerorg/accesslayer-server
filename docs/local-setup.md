# Local Setup Guide

This guide walks you through setting up the Access Layer server for local development.

## Prerequisites

- **Node.js** v20+ (check with `node --version`)
- **pnpm** v10+ (check with `pnpm --version`)
- **Docker** (for PostgreSQL database)

## Step-by-Step Setup

### 1. Clone the Repository

```bash
git clone https://github.com/accesslayerorg/accesslayer-server.git
cd accesslayer-server
```

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` with your local configuration. The defaults work with the included Docker setup.

### 4. Start the Database

```bash
pnpm db:up
```

This starts a PostgreSQL container on port 5432.

### 5. Generate Prisma Client

```bash
pnpm generate
```

### 6. Run Database Migrations

```bash
pnpm migrate
```

### 7. Start the Development Server

**API Server:**

```bash
pnpm dev
```

The server starts on `http://localhost:3000`.

**Indexer (if applicable):**

```bash
# Check package.json for indexer-specific scripts
pnpm start:indexer
```

## Verification

### Health Check

```bash
curl http://localhost:3000/api/v1/health
```

Expected response:

```json
{
   "success": true,
   "message": "OK",
   "timestamp": "2025-01-15T10:30:00.000Z"
}
```

### API Docs

Open in browser:

```
http://localhost:3000/api-docs
```

### Test Creator List

```bash
curl http://localhost:3000/api/v1/creators
```

## Database Commands

| Command        | Description                |
| -------------- | -------------------------- |
| `pnpm db:up`   | Start PostgreSQL container |
| `pnpm db:down` | Stop PostgreSQL container  |
| `pnpm db:logs` | View database logs         |
| `pnpm migrate` | Run migrations             |
| `pnpm studio`  | Open Prisma Studio         |

## Troubleshooting

### Port Already in Use

If port 3000 is occupied, update `PORT` in `.env`:

```
PORT=3001
```

### Database Connection Failed

1. Ensure Docker is running: `docker ps`
2. Check if PostgreSQL container is up: `pnpm db:logs`
3. Verify `DATABASE_URL` in `.env` matches Docker defaults

### Prisma Generation Failed

```bash
rm -rf node_modules/.prisma
pnpm generate
```

## Next Steps

- See [API Endpoints](./api-endpoints.md) for available routes
- Read [CONTRIBUTING.md](../CONTRIBUTING.md) for development workflow
