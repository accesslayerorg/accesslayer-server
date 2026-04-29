# Configuration Guide

## Overview

The Access Layer server uses a layered configuration system with clear source precedence. Configuration values are loaded from environment variables, with schema validation and default values applied at startup.

## Configuration Source Precedence

Configuration values are resolved in the following order (highest to lowest priority):

1. **Environment Variables** (`.env` file or system environment)
2. **Schema Defaults** (defined in `src/config.ts`)
3. **Validation Failure** (startup fails if required values are missing)

### Precedence Rules

```
Environment Variable → Schema Default → Required (fail if missing)
```

**Example:**
```typescript
PORT: z.coerce.number().default(3000)
```
- If `PORT=4000` in `.env` → uses `4000`
- If `PORT` not set → uses default `3000`

```typescript
DATABASE_URL: z.string().min(1, 'DATABASE_URL is required')
```
- If `DATABASE_URL` in `.env` → uses that value
- If `DATABASE_URL` not set → **startup fails** with error message

## Configuration Loading Process

### 1. Environment File Loading

The server loads environment variables from `.env` file at startup:

```typescript
import dotenv from 'dotenv';
dotenv.config();
```

**File Location:** `.env` in project root

**Loading Behavior:**
- Reads `.env` file if it exists
- Does not override existing environment variables
- Silent if `.env` file is missing (uses system environment)

### 2. Schema Validation

All configuration values are validated using Zod schemas:

```typescript
export const envSchema = z.object({
   PORT: z.coerce.number().default(3000),
   MODE: z.enum(['development', 'production', 'test']).default('development'),
   DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
   // ... more fields
});

export const envConfig = envSchema.parse(process.env);
```

**Validation Process:**
1. Reads `process.env` (includes `.env` values)
2. Applies type coercion (e.g., string → number)
3. Validates against schema rules
4. Applies default values for missing optional fields
5. Fails startup if required fields are missing

### 3. Runtime Access

Configuration is accessed via exported constants:

```typescript
import { envConfig, appConfig } from './config';

// Use configuration values
const port = envConfig.PORT;
const origins = appConfig.allowedOrigins;
```

## Configuration Categories

### Required Configuration

These values **must** be provided via environment variables:

| Variable | Type | Description |
|----------|------|-------------|
| `DATABASE_URL` | string | PostgreSQL connection string |
| `GMAIL_USER` | string | Gmail account for email sending |
| `GMAIL_APP_PASSWORD` | string | Gmail app-specific password |
| `GOOGLE_CLIENT_ID` | string | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | string | Google OAuth client secret |
| `BACKEND_URL` | URL | Backend server URL |
| `FRONTEND_URL` | URL | Frontend application URL |
| `CLOUDINARY_CLOUD_NAME` | string | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | string | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | string | Cloudinary API secret |
| `PAYSTACK_SECRET_KEY` | string | Paystack secret key |

**Startup Behavior:** Server fails to start if any required value is missing.

### Optional Configuration with Defaults

These values have defaults and can be overridden:

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PORT` | number | `3000` | Server port |
| `MODE` | enum | `development` | Environment mode |
| `APP_SECRET` | string | (dev key) | Secret for signing/encryption |
| `API_VERSION` | string | `1.0.0` | API version string |
| `ENABLE_RESPONSE_TIMING` | boolean | `true` | Enable timing headers |
| `ENABLE_API_VERSION_HEADER` | boolean | `true` | Enable version header |
| `ENABLE_SCHEMA_VERSION_HEADER` | boolean | `true` | Enable schema header |
| `ENABLE_REQUEST_LOGGING` | boolean | `true` | Enable request logging |
| `INDEXER_JITTER_FACTOR` | number | `0.1` | Jitter factor (0-1) |
| `BACKGROUND_JOB_LOCK_TTL_MS` | number | `300000` | Job lock TTL (5 min) |
| `CREATOR_LIST_SLOW_QUERY_THRESHOLD_MS` | number | `500` | Slow query threshold |
| `INDEXER_CURSOR_STALE_AGE_WARNING_MS` | number | `300000` | Stale cursor warning (5 min) |
| `PAYSTACK_PUBLIC_KEY` | string | (optional) | Paystack public key |

**Startup Behavior:** Uses default if not provided in environment.

### Derived Configuration

Some configuration values are computed from other values:

```typescript
export const appConfig = {
   allowedOrigins: [
      'http://localhost:5173',
      'http://localhost:3000',
      envConfig.FRONTEND_URL,
   ].filter(Boolean),
};
```

**Source:** Computed at startup from `envConfig` values.

## Configuration by Environment

### Development

**Recommended `.env` values:**
```bash
MODE=development
PORT=3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/accesslayer
BACKEND_URL=http://localhost:3000
FRONTEND_URL=http://localhost:5173
APP_SECRET=your_32_character_long_secret_string_here
```

**Behavior:**
- Verbose logging (includes query logs)
- Detailed error messages with stack traces
- Higher rate limits
- Development-specific CORS origins

### Production

**Required environment variables:**
```bash
MODE=production
PORT=3000
DATABASE_URL=postgresql://user:pass@host:5432/db
BACKEND_URL=https://api.yourdomain.com
FRONTEND_URL=https://yourdomain.com
APP_SECRET=<secure-random-32-char-string>
# ... all other required variables
```

**Behavior:**
- Minimal logging (errors only)
- Generic error messages (no stack traces)
- Stricter rate limits
- Production CORS origins only

### Test

**Recommended `.env.test` values:**
```bash
MODE=test
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/accesslayer_test
# ... minimal required values for tests
```

**Behavior:**
- Test-specific database
- Minimal logging
- Fast timeouts

## Type Coercion

The configuration system automatically coerces string values to appropriate types:

### Number Coercion

```typescript
PORT: z.coerce.number().default(3000)
```

**Examples:**
- `PORT=4000` → `4000` (number)
- `PORT="4000"` → `4000` (number)
- `PORT=invalid` → validation error

### Boolean Coercion

```typescript
ENABLE_RESPONSE_TIMING: z.coerce.boolean().default(true)
```

**Examples:**
- `ENABLE_RESPONSE_TIMING=true` → `true`
- `ENABLE_RESPONSE_TIMING=false` → `false`
- `ENABLE_RESPONSE_TIMING=1` → `true`
- `ENABLE_RESPONSE_TIMING=0` → `false`
- `ENABLE_RESPONSE_TIMING=""` → `false`

### Enum Validation

```typescript
MODE: z.enum(['development', 'production', 'test']).default('development')
```

**Examples:**
- `MODE=production` → `"production"`
- `MODE=invalid` → validation error

## Validation Rules

### String Validation

```typescript
DATABASE_URL: z.string().min(1, 'DATABASE_URL is required')
```
- Must be non-empty string
- Fails with custom error message if missing

### URL Validation

```typescript
FRONTEND_URL: z.string().url('FRONTEND_URL must be a valid URL')
```
- Must be valid URL format
- Includes protocol (http:// or https://)

### Number Range Validation

```typescript
INDEXER_JITTER_FACTOR: z.coerce.number().min(0).max(1).default(0.1)
```
- Must be between 0 and 1
- Coerced from string to number

### Positive Integer Validation

```typescript
BACKGROUND_JOB_LOCK_TTL_MS: z.coerce.number().int().positive().default(300000)
```
- Must be positive integer
- No decimals allowed

## Configuration Access Patterns

### Direct Access

```typescript
import { envConfig } from './config';

const port = envConfig.PORT;
const mode = envConfig.MODE;
```

### Conditional Logic

```typescript
if (envConfig.MODE === 'development') {
   // Development-specific behavior
}

if (envConfig.ENABLE_REQUEST_LOGGING) {
   // Enable logging middleware
}
```

### Default Parameters

```typescript
function warnIfStale(
   lastUpdated: Date,
   thresholdMs: number = envConfig.INDEXER_CURSOR_STALE_AGE_WARNING_MS
) {
   // Use config value as default
}
```

## Troubleshooting

### Startup Fails with "Required" Error

**Error:**
```
ZodError: DATABASE_URL is required in the environment variables
```

**Solution:**
1. Check `.env` file exists in project root
2. Verify variable is defined: `DATABASE_URL=...`
3. Ensure no typos in variable name
4. Restart server after changing `.env`

### Type Validation Errors

**Error:**
```
ZodError: Expected number, received string
```

**Solution:**
1. Check value format matches expected type
2. For numbers: use digits only (e.g., `PORT=3000`)
3. For booleans: use `true`/`false` or `1`/`0`
4. For enums: use exact allowed values

### URL Validation Errors

**Error:**
```
ZodError: FRONTEND_URL must be a valid URL
```

**Solution:**
1. Include protocol: `https://example.com` not `example.com`
2. Check for typos in URL
3. Ensure no trailing spaces

### Environment Variables Not Loading

**Symptoms:**
- Defaults used instead of `.env` values
- Changes to `.env` not reflected

**Solution:**
1. Verify `.env` file is in project root (not `src/`)
2. Restart server after changing `.env`
3. Check file is named exactly `.env` (not `.env.txt`)
4. Verify no syntax errors in `.env` file

## Security Best Practices

### Secrets Management

**Development:**
- Use `.env` file (gitignored)
- Never commit `.env` to version control
- Use `.env.example` as template

**Production:**
- Use environment variables from hosting platform
- Use secrets management service (AWS Secrets Manager, etc.)
- Rotate secrets regularly

### APP_SECRET

**Requirements:**
- Minimum 32 characters
- Use cryptographically random string
- Different value per environment

**Generate secure secret:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Database Credentials

**Best Practices:**
- Use strong passwords
- Limit database user permissions
- Use SSL/TLS for connections
- Rotate credentials regularly

## Configuration File Reference

### Primary Files

| File | Purpose | Version Control |
|------|---------|-----------------|
| `.env` | Local environment variables | ❌ Gitignored |
| `.env.example` | Template with defaults | ✅ Committed |
| `src/config.ts` | Schema and validation | ✅ Committed |

### Configuration Flow

```
.env file
    ↓
process.env (merged with system env)
    ↓
dotenv.config() (loads .env)
    ↓
envSchema.parse(process.env) (validates)
    ↓
envConfig (typed, validated config)
    ↓
Application code
```

## Adding New Configuration

### 1. Add to Schema

Edit `src/config.ts`:

```typescript
export const envSchema = z.object({
   // ... existing fields
   NEW_CONFIG_VALUE: z.string().default('default-value'),
});
```

### 2. Add to .env.example

Edit `.env.example`:

```bash
# Description of what this does
NEW_CONFIG_VALUE=example-value
```

### 3. Document in This File

Add to appropriate table in this documentation.

### 4. Use in Code

```typescript
import { envConfig } from './config';

const value = envConfig.NEW_CONFIG_VALUE;
```

## Related Documentation

- [API Versioning](./api-versioning.md) - API version configuration
- [Query Debug](./query-normalization-debug.md) - Debug logging configuration
- [README](../README.md) - Local setup instructions
