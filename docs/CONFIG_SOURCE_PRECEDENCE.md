# Configuration Source Precedence - Quick Reference

## Source Priority (Highest to Lowest)

```
1. Environment Variables (.env or system)
   ↓
2. Schema Defaults (src/config.ts)
   ↓
3. Validation Failure (startup fails)
```

## Visual Flow

```
┌─────────────────────────────────────────┐
│  .env File or System Environment        │
│  PORT=4000                               │
│  MODE=production                         │
│  DATABASE_URL=postgresql://...           │
└─────────────────┬───────────────────────┘
                  │
                  ↓
┌─────────────────────────────────────────┐
│  dotenv.config()                         │
│  Loads .env into process.env             │
└─────────────────┬───────────────────────┘
                  │
                  ↓
┌─────────────────────────────────────────┐
│  Zod Schema Validation                   │
│  envSchema.parse(process.env)            │
│                                           │
│  For each field:                         │
│  1. Check process.env[FIELD]             │
│  2. Apply type coercion                  │
│  3. Use default if missing (optional)    │
│  4. Fail if missing (required)           │
└─────────────────┬───────────────────────┘
                  │
                  ↓
┌─────────────────────────────────────────┐
│  envConfig Object                        │
│  Typed, validated configuration          │
│  Ready for application use               │
└─────────────────────────────────────────┘
```

## Decision Tree

```
Is variable in .env or system environment?
│
├─ YES → Use that value
│        ↓
│        Apply type coercion
│        ↓
│        Validate against schema
│        ↓
│        ✓ Success
│
└─ NO → Does schema have .default()?
        │
        ├─ YES → Use default value
        │        ↓
        │        ✓ Success
        │
        └─ NO → Is field required?
                │
                ├─ YES → ✗ Fail startup
                │        (throw validation error)
                │
                └─ NO → Use undefined
                         ↓
                         ✓ Success
```

## Examples by Configuration Type

### Example 1: Optional with Default

**Schema:**
```typescript
PORT: z.coerce.number().default(3000)
```

**Scenarios:**

| .env Value | Result | Source |
|------------|--------|--------|
| `PORT=4000` | `4000` | Environment |
| `PORT=` (empty) | `3000` | Default |
| (not set) | `3000` | Default |

### Example 2: Required (No Default)

**Schema:**
```typescript
DATABASE_URL: z.string().min(1, 'DATABASE_URL is required')
```

**Scenarios:**

| .env Value | Result | Source |
|------------|--------|--------|
| `DATABASE_URL=postgresql://...` | `postgresql://...` | Environment |
| `DATABASE_URL=` (empty) | ❌ Startup fails | Validation error |
| (not set) | ❌ Startup fails | Validation error |

### Example 3: Optional with Validation

**Schema:**
```typescript
PAYSTACK_PUBLIC_KEY: z.string().min(1).optional()
```

**Scenarios:**

| .env Value | Result | Source |
|------------|--------|--------|
| `PAYSTACK_PUBLIC_KEY=pk_test_123` | `pk_test_123` | Environment |
| `PAYSTACK_PUBLIC_KEY=` (empty) | `undefined` | Optional |
| (not set) | `undefined` | Optional |

### Example 4: Enum with Default

**Schema:**
```typescript
MODE: z.enum(['development', 'production', 'test']).default('development')
```

**Scenarios:**

| .env Value | Result | Source |
|------------|--------|--------|
| `MODE=production` | `production` | Environment |
| `MODE=invalid` | ❌ Startup fails | Validation error |
| (not set) | `development` | Default |

## Configuration Categories Summary

### 🔴 Required (Must Provide)

No defaults. Startup fails if missing.

```
DATABASE_URL
GMAIL_USER
GMAIL_APP_PASSWORD
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
BACKEND_URL
FRONTEND_URL
CLOUDINARY_CLOUD_NAME
CLOUDINARY_API_KEY
CLOUDINARY_API_SECRET
PAYSTACK_SECRET_KEY
```

**Source Precedence:**
```
Environment → Validation Failure
```

### 🟡 Optional with Defaults

Has defaults. Uses default if not provided.

```
PORT (default: 3000)
MODE (default: 'development')
APP_SECRET (default: dev key)
API_VERSION (default: '1.0.0')
ENABLE_RESPONSE_TIMING (default: true)
ENABLE_API_VERSION_HEADER (default: true)
ENABLE_SCHEMA_VERSION_HEADER (default: true)
ENABLE_REQUEST_LOGGING (default: true)
INDEXER_JITTER_FACTOR (default: 0.1)
BACKGROUND_JOB_LOCK_TTL_MS (default: 300000)
CREATOR_LIST_SLOW_QUERY_THRESHOLD_MS (default: 500)
INDEXER_CURSOR_STALE_AGE_WARNING_MS (default: 300000)
```

**Source Precedence:**
```
Environment → Schema Default
```

### 🟢 Optional (No Default)

Optional. Uses `undefined` if not provided.

```
PAYSTACK_PUBLIC_KEY
```

**Source Precedence:**
```
Environment → undefined
```

## Type Coercion Examples

### String to Number

**Schema:** `z.coerce.number()`

| Input | Output | Notes |
|-------|--------|-------|
| `"3000"` | `3000` | String coerced to number |
| `3000` | `3000` | Already number |
| `"abc"` | ❌ Error | Invalid number |
| `""` | ❌ Error | Empty string |

### String to Boolean

**Schema:** `z.coerce.boolean()`

| Input | Output | Notes |
|-------|--------|-------|
| `"true"` | `true` | String to boolean |
| `"false"` | `false` | String to boolean |
| `"1"` | `true` | Truthy coercion |
| `"0"` | `false` | Falsy coercion |
| `""` | `false` | Empty is falsy |
| `true` | `true` | Already boolean |

## Override Hierarchy

When the same variable is defined in multiple places:

```
System Environment Variables (highest priority)
    ↓
.env File
    ↓
Schema Defaults
    ↓
Validation Failure (lowest priority)
```

**Example:**

```bash
# System environment
export PORT=5000

# .env file
PORT=4000

# Schema
PORT: z.coerce.number().default(3000)
```

**Result:** `PORT = 5000` (system environment wins)

**Note:** `dotenv.config()` does NOT override existing environment variables.

## Common Patterns

### Pattern 1: Feature Flags

```typescript
ENABLE_FEATURE: z.coerce.boolean().default(false)
```

**Usage:**
```typescript
if (envConfig.ENABLE_FEATURE) {
   // Feature enabled
}
```

**Source:** Environment → Default (false)

### Pattern 2: Timeouts/Thresholds

```typescript
TIMEOUT_MS: z.coerce.number().int().positive().default(5000)
```

**Usage:**
```typescript
setTimeout(() => {}, envConfig.TIMEOUT_MS);
```

**Source:** Environment → Default (5000)

### Pattern 3: Environment-Specific Behavior

```typescript
MODE: z.enum(['development', 'production', 'test']).default('development')
```

**Usage:**
```typescript
if (envConfig.MODE === 'production') {
   // Production-only behavior
}
```

**Source:** Environment → Default ('development')

### Pattern 4: Secrets with Dev Defaults

```typescript
APP_SECRET: z.string().min(32).default('dev_secret_32_chars_long_string')
```

**Usage:**
```typescript
const secret = envConfig.APP_SECRET;
```

**Source:** Environment → Default (dev key)

**⚠️ Warning:** Always override in production!

## Validation Failure Examples

### Missing Required Field

```
Error: ZodError
Issues:
  - DATABASE_URL is required in the environment variables
```

**Fix:** Add `DATABASE_URL=...` to `.env`

### Invalid Type

```
Error: ZodError
Issues:
  - PORT: Expected number, received string
```

**Fix:** Ensure `PORT=3000` (valid number)

### Invalid Enum Value

```
Error: ZodError
Issues:
  - MODE: Invalid enum value. Expected 'development' | 'production' | 'test', received 'staging'
```

**Fix:** Use valid enum value: `MODE=production`

### Invalid URL Format

```
Error: ZodError
Issues:
  - FRONTEND_URL must be a valid URL
```

**Fix:** Include protocol: `FRONTEND_URL=https://example.com`

## Runtime Behavior

### Startup Sequence

1. **Load .env file** → `dotenv.config()`
2. **Parse environment** → `envSchema.parse(process.env)`
3. **Validate all fields** → Apply coercion, defaults, validation
4. **Export config** → `envConfig` available for import
5. **Start server** → Use `envConfig` values

### Configuration is Immutable

Once loaded at startup, configuration values do not change:

```typescript
// ❌ This does NOT work
envConfig.PORT = 4000; // TypeError: Cannot assign to read only property

// ✓ Configuration is read-only
const port = envConfig.PORT; // Always returns same value
```

**To change configuration:** Restart server with new environment values.

## Quick Troubleshooting

| Symptom | Likely Cause | Solution |
|---------|--------------|----------|
| Startup fails with "required" error | Missing required env var | Add to `.env` |
| Using default instead of .env value | Typo in variable name | Check spelling |
| Changes not reflected | Server not restarted | Restart server |
| Type validation error | Wrong value format | Check type (number, boolean, etc.) |
| URL validation error | Missing protocol | Add `https://` |

## See Also

- [Configuration Guide](./configuration.md) - Complete documentation
- [.env.example](../.env.example) - Template with all variables
- [src/config.ts](../src/config.ts) - Schema definitions
