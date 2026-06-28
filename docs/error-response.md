# API Error Response Format

All error responses from the API follow a consistent structure to enable predictable client-side error handling.

## Response Shape

Every error response is a JSON object with the following fields:

| Field | Type | Required? | Description |
|-------|------|-----------|-------------|
| `success` | `boolean` | **Always** | Always `false` for error responses. |
| `requestId` | `string` | Optional | Unique identifier for the request, present when available from the async-local-storage context (omitted outside request lifecycle, e.g., in tests). |
| `error` | `object` | **Always** | Contains error details. |
| `error.code` | `string` | **Always** | Machine-readable error code (see [Error Code Registry](./ERROR_CODE_REGISTRY.md)). |
| `error.message` | `string` | **Always** | Human-readable error message. |
| `error.details` | `Array<{ field?: string; message: string }>` | Optional | Additional validation details (present only for validation errors, e.g., 400 responses from Zod schema validation). Each object may include a `field` indicating which field failed validation and a `message` describing the validation error. |

## Guarantees

- `success` is guaranteed to be `false`.
- `error` object is always present.
- `error.code` and `error.message` are always present within the `error` object.
- `requestId` is included when the request ID is available in the async-local-storage context; otherwise, it is omitted entirely.
- `error.details` is included only when the error provides per-field validation information (typically 400 Bad Request responses from schema validation). When absent, the field is omitted.

## Example Error Responses

### 400 Bad Request – Validation Error
```json
{
  "success": false,
  "requestId": "a1b2c3d4-e5f6-7890-g1h2-i3j4k5l6m7n8",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "details": [
      { "field": "email", "message": "Invalid email format" },
      { "field": "password", "message": "Password must be at least 8 characters" }
    ]
  }
}
```

### 400 Bad Request – Generic (e.g., invalid JSON)
```json
{
  "success": false,
  "requestId": "a1b2c3d4-e5f6-7890-g1h2-i3j4k5l6m7n8",
  "error": {
    "code": "BAD_REQUEST",
    "message": "Invalid JSON format"
  }
}
```

### 401 Unauthorized
```json
{
  "success": false,
  "requestId": "a1b2c3d4-e5f6-7890-g1h2-i3j4k5l6m7n8",
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid or expired token"
  }
}
```

### 403 Forbidden
```json
{
  "success": false,
  "requestId": "a1b2c3d4-e5f6-7890-g1h2-i3j4k5l6m7n8",
  "error": {
    "code": "FORBIDDEN",
    "message": "Access forbidden"
  }
}
```

### 404 Not Found
```json
{
  "success": false,
  "requestId": "a1b2c3d4-e5f6-7890-g1h2-i3j4k5l6m7n8",
  "error": {
    "code": "NOT_FOUND",
    "message": "User not found"
  }
}
```

### 409 Conflict
```json
{
  "success": false,
  "requestId": "a1b2c3d4-e5f6-7890-g1h2-i3j4k5l6m7n8",
  "error": {
    "code": "CONFLICT",
    "message": "Record already exists (unique constraint violation)"
  }
}
```

### 413 Payload Too Large
```json
{
  "success": false,
  "requestId": "a1b2c3d4-e5f6-7890-g1h2-i3j4k5l6m7n8",
  "error": {
    "code": "BAD_REQUEST",
    "message": "Request payload too large"
  }
}
```

### 429 Rate Limited
```json
{
  "success": false,
  "requestId": "a1b2c3d4-e5f6-7890-g1h2-i3j4k5l6m7n8",
  "error": {
    "code": "RATE_LIMIT",
    "message": "Too many requests, please try again later"
  }
}
```

### 500 Internal Server Error
```json
{
  "success": false,
  "requestId": "a1b2c3d4-e5f6-7890-g1h2-i3j4k5l6m7n8",
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An unexpected error occurred"
  }
}
```

### 503 Service Temporarily Disabled
```json
{
  "success": false,
  "requestId": "a1b2c3d4-e5f6-7890-g1h2-i3j4k5l6m7n8",
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "This endpoint is temporarily disabled"
  }
}
```

## Notes

- In development mode (`envConfig.MODE === 'development'`), certain error responses may include an additional `error` field at the top level containing the original error message for debugging (e.g., Prisma errors). This field is **not** part of the documented contract and should not be relied upon by clients.
- The `requestId` correlates with server logs, enabling traceability across services when request IDs are propagated.