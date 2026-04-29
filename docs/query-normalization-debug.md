# Query Normalization Debug Helper

## Overview

The query normalization debug helper provides diagnostic snapshots of query parsing and normalization for troubleshooting and validation purposes. It's designed to be optional, secure, and zero-overhead when not in use.

## Features

### 1. Optional Debug Logging
- Only active when logger is set to `debug` level
- Zero performance impact in production (info/warn/error levels)
- Controlled via environment or logger configuration

### 2. Automatic Sanitization
- Prevents sensitive data leakage in debug logs
- Redacts fields matching sensitive patterns:
  - `password`, `token`, `secret`, `key`
  - `auth`, `credential`, `email`, `phone`
  - `ssn`, `credit`, `card`
- Case-insensitive pattern matching
- Recursive sanitization for nested objects and arrays

### 3. Comprehensive Snapshots
Each debug snapshot includes:
- **raw**: Original query before normalization
- **normalized**: Parsed and transformed query
- **valid**: Whether validation passed
- **errors**: Validation error details (if any)
- **timestamp**: ISO 8601 timestamp
- **context**: Optional label for identifying query source

## Usage

### Basic Usage

```typescript
import { parsePublicQuery } from '../utils/public-query-parse.utils';
import { CreatorListQuerySchema } from './creators.schemas';

// Add debugContext option to enable debug snapshots
const parsed = parsePublicQuery(
   CreatorListQuerySchema,
   req.query,
   { debugContext: 'creator-list-query' }
);
```

### Direct Usage

```typescript
import { emitQueryNormalizationDebug } from '../utils/query-normalization-debug.utils';

// Manually emit a debug snapshot
emitQueryNormalizationDebug({
   raw: req.query,
   normalized: validatedQuery,
   valid: true,
   context: 'custom-query',
});
```

### Reusable Emitter

```typescript
import { createQueryDebugEmitter } from '../utils/query-normalization-debug.utils';

// Create a reusable emitter with fixed context
const debugCreatorQuery = createQueryDebugEmitter('creator-list');

// Use it multiple times
debugCreatorQuery({
   raw: req.query,
   normalized: validatedQuery,
   valid: true,
});
```

## Configuration

### Enable Debug Logging

Set the logger level to `debug` in your environment:

```typescript
// In logger.utils.ts or config
export const logger = pino({
   level: process.env.LOG_LEVEL || 'info', // Change to 'debug'
   // ... other config
});
```

Or via environment variable:
```bash
LOG_LEVEL=debug npm run dev
```

### Disable Debug Logging (Default)

Keep logger at `info` level or higher:
```bash
LOG_LEVEL=info npm start
```

## Debug Output Example

When debug logging is enabled, you'll see output like:

```json
{
  "level": 20,
  "time": "2026-04-28T16:30:00.000Z",
  "msg": "Query normalization debug snapshot",
  "queryNormalization": {
    "raw": {
      "limit": "20",
      "offset": "0",
      "sort": "createdAt",
      "order": "desc",
      "search": "  alice  "
    },
    "normalized": {
      "limit": 20,
      "offset": 0,
      "sort": "createdAt",
      "order": "desc",
      "search": "alice"
    },
    "valid": true,
    "timestamp": "2026-04-28T16:30:00.123Z",
    "context": "creator-list-query"
  }
}
```

### With Validation Errors

```json
{
  "level": 20,
  "time": "2026-04-28T16:30:00.000Z",
  "msg": "Query normalization debug snapshot",
  "queryNormalization": {
    "raw": {
      "limit": "invalid",
      "offset": "0"
    },
    "normalized": null,
    "valid": false,
    "errors": [
      {
        "field": "limit",
        "message": "Expected number, received string"
      }
    ],
    "timestamp": "2026-04-28T16:30:00.123Z",
    "context": "creator-list-query"
  }
}
```

### With Sensitive Data (Sanitized)

```json
{
  "level": 20,
  "time": "2026-04-28T16:30:00.000Z",
  "msg": "Query normalization debug snapshot",
  "queryNormalization": {
    "raw": {
      "username": "alice",
      "password": "[REDACTED]",
      "email": "[REDACTED]",
      "token": "[REDACTED]"
    },
    "normalized": null,
    "valid": false,
    "timestamp": "2026-04-28T16:30:00.123Z",
    "context": "auth-query"
  }
}
```

## Security Considerations

### Sensitive Field Patterns

The helper automatically redacts fields matching these patterns:
- `password` - Passwords, passphrases
- `token` - Auth tokens, API tokens, JWT tokens
- `secret` - API secrets, client secrets
- `key` - API keys, encryption keys
- `auth` - Authorization headers, auth codes
- `credential` - User credentials
- `email` - Email addresses (PII)
- `phone` - Phone numbers (PII)
- `ssn` - Social security numbers (PII)
- `credit` - Credit card info
- `card` - Card numbers

### Adding Custom Patterns

To add more sensitive patterns, edit `SENSITIVE_FIELD_PATTERNS` in `query-normalization-debug.utils.ts`:

```typescript
const SENSITIVE_FIELD_PATTERNS = [
   'password',
   'token',
   // ... existing patterns
   'custom_sensitive_field', // Add your pattern
] as const;
```

### Best Practices

1. **Never log in production** - Keep logger at `info` or higher
2. **Review logs before sharing** - Even with sanitization, review debug logs
3. **Limit debug sessions** - Only enable debug logging when actively troubleshooting
4. **Rotate logs** - Ensure debug logs are rotated and not persisted long-term

## Use Cases

### 1. Diagnosing Query Parsing Issues

When users report unexpected query behavior:
```typescript
// Enable debug logging
// Reproduce the issue
// Check logs for normalization snapshots
```

### 2. Validating Normalization Logic

When implementing new query transformations:
```typescript
const parsed = parsePublicQuery(
   NewQuerySchema,
   testQuery,
   { debugContext: 'new-query-test' }
);
// Check debug output to verify transformations
```

### 3. Understanding Query Flow

When onboarding new developers:
```typescript
// Enable debug logging
// Make API requests
// Review debug snapshots to understand query processing
```

### 4. Testing Edge Cases

When testing unusual query inputs:
```typescript
const edgeCases = [
   { limit: '  10  ', offset: '' },
   { search: '   multiple   spaces   ' },
   { sort: 'UPPERCASE' },
];

edgeCases.forEach(query => {
   parsePublicQuery(schema, query, { debugContext: 'edge-case-test' });
});
// Review debug output for each case
```

## Performance Impact

### When Debug Logging is Disabled (Default)
- **Zero overhead** - Early return if debug level not enabled
- **No sanitization** - Sanitization only runs when logging
- **No object cloning** - No memory allocation for snapshots

### When Debug Logging is Enabled
- **Minimal overhead** - Only sanitization and JSON serialization
- **Async logging** - Pino handles logging asynchronously
- **Bounded memory** - Snapshots are logged and released immediately

## Testing

Run the test suite to verify functionality:

```bash
npx ts-node src/utils/test/query-normalization-debug.utils.test.ts
```

Tests cover:
- Debug log emission when enabled/disabled
- Sensitive field sanitization
- Nested object sanitization
- Array sanitization
- Validation error inclusion
- Timestamp generation
- Reusable emitter creation
- Case-insensitive pattern matching
- Null/undefined handling

## Integration Points

The debug helper is integrated into:

1. **`parsePublicQuery`** - Optional `debugContext` parameter
2. **Creator list controller** - Example usage with `creator-list-query` context
3. **Any custom query parser** - Direct usage via `emitQueryNormalizationDebug`

## Related Files

- `src/utils/query-normalization-debug.utils.ts` - Main implementation
- `src/utils/test/query-normalization-debug.utils.test.ts` - Test suite
- `src/utils/public-query-parse.utils.ts` - Integration point
- `src/modules/creators/creators.controllers.ts` - Example usage
- `src/utils/logger.utils.ts` - Logger configuration

## Future Enhancements

Potential improvements:
- Configurable sanitization patterns via environment
- Query performance metrics in snapshots
- Diff view for before/after normalization
- Export snapshots to external monitoring tools
- Query replay functionality for debugging
