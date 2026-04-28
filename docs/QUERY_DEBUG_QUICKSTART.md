# Query Normalization Debug - Quick Start Guide

## Enable Debug Logging

### Option 1: Environment Variable
```bash
LOG_LEVEL=debug npm run dev
```

### Option 2: Code Change
Edit `src/utils/logger.utils.ts`:
```typescript
export const logger = pino({
   level: 'debug', // Change from 'info'
   // ... rest of config
});
```

## Add Debug Context to Query Parsing

### In Controllers
```typescript
import { parsePublicQuery } from '../../utils/public-query-parse.utils';

const parsed = parsePublicQuery(
   YourQuerySchema,
   req.query,
   { debugContext: 'your-endpoint-name' } // Add this
);
```

### Direct Usage
```typescript
import { emitQueryNormalizationDebug } from '../../utils/query-normalization-debug.utils';

emitQueryNormalizationDebug({
   raw: req.query,
   normalized: validatedQuery,
   valid: true,
   context: 'your-context',
});
```

## View Debug Output

Make a request to your endpoint:
```bash
curl "http://localhost:3000/api/v1/creators?limit=10&search=alice"
```

Look for log entries like:
```json
{
  "level": 20,
  "msg": "Query normalization debug snapshot",
  "queryNormalization": {
    "raw": { "limit": "10", "search": "alice" },
    "normalized": { "limit": 10, "search": "alice" },
    "valid": true,
    "context": "creator-list-query"
  }
}
```

## Disable Debug Logging

### Option 1: Environment Variable
```bash
LOG_LEVEL=info npm start
```

### Option 2: Code Change
Edit `src/utils/logger.utils.ts`:
```typescript
export const logger = pino({
   level: 'info', // Change back from 'debug'
   // ... rest of config
});
```

## Common Use Cases

### Debugging Invalid Queries
```bash
# Make invalid request
curl "http://localhost:3000/api/v1/creators?limit=invalid"

# Check logs for validation errors
{
  "queryNormalization": {
    "valid": false,
    "errors": [
      { "field": "limit", "message": "Expected number, received string" }
    ]
  }
}
```

### Verifying Normalization
```bash
# Request with whitespace
curl "http://localhost:3000/api/v1/creators?search=%20%20alice%20%20"

# Check logs to see trimmed value
{
  "queryNormalization": {
    "raw": { "search": "  alice  " },
    "normalized": { "search": "alice" }
  }
}
```

### Testing Edge Cases
```bash
# Empty values
curl "http://localhost:3000/api/v1/creators?search=&limit="

# Special characters
curl "http://localhost:3000/api/v1/creators?search=alice%20%26%20bob"

# Check logs for normalization behavior
```

## Security Note

Sensitive fields are automatically redacted:
```json
{
  "raw": {
    "username": "alice",
    "password": "[REDACTED]",
    "email": "[REDACTED]"
  }
}
```

## Performance Note

Debug logging has **zero overhead** when disabled (default production setting).

## More Information

See [docs/query-normalization-debug.md](./query-normalization-debug.md) for complete documentation.
