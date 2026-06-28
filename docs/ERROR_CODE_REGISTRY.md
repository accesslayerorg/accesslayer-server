# Error Code Registry

This document defines all error codes used in the Access Layer API and provides guidance for when to add new codes.

## Overview

Error codes are machine-readable identifiers that allow clients to programmatically handle specific error conditions. They are returned in all error responses under the `code` field:

```json
{
   "success": false,
   "error": {
      "code": "VALIDATION_ERROR",
      "message": "Invalid query parameters"
   }
}
```

Error codes are defined in `src/constants/error.constants.ts` and should be treated as stable, public contracts. Changing or removing codes is a breaking change for API consumers.

## Error Code Reference

### VALIDATION_ERROR

**HTTP Status:** 400 Bad Request

**Meaning:** The request contains invalid data that failed schema validation.

**When to use:**

- Query parameters fail Zod schema validation
- Request body fails schema validation
- Required fields are missing
- Field values are outside allowed ranges or formats

**Example:**

```json
{
   "success": false,
   "error": {
      "code": "VALIDATION_ERROR",
      "message": "Invalid query parameters",
      "details": [{ "field": "limit", "message": "Must be between 1 and 100" }]
   }
}
```

---

### NOT_FOUND

**HTTP Status:** 404 Not Found

**Meaning:** The requested resource does not exist.

**When to use:**

- A creator profile with the given ID does not exist
- A route path does not exist
- A resource was deleted or never existed

**Example:**

```json
{
   "success": false,
   "error": {
      "code": "NOT_FOUND",
      "message": "Creator not found"
   }
}
```

---

### UNAUTHORIZED

**HTTP Status:** 401 Unauthorized

**Meaning:** Authentication is required or has failed.

**When to use:**

- No authentication token is provided when required
- Authentication token is invalid or expired
- Wallet address is required but not provided
- Wallet address is not registered

**Example:**

```json
{
   "success": false,
   "error": {
      "code": "UNAUTHORIZED",
      "message": "Invalid or expired token"
   }
}
```

---

### FORBIDDEN

**HTTP Status:** 403 Forbidden

**Meaning:** The authenticated user does not have permission to access this resource.

**When to use:**

- User is authenticated but lacks required permissions
- Wallet does not own the requested resource
- Access control check fails

**Example:**

```json
{
   "success": false,
   "error": {
      "code": "FORBIDDEN",
      "message": "Wallet does not own the requested resource"
   }
}
```

---

### CONFLICT

**HTTP Status:** 409 Conflict

**Meaning:** The request conflicts with the current state of the resource.

**When to use:**

- Attempting to create a resource that already exists (unique constraint violation)
- Attempting to update a resource that has been modified since retrieval
- State transition is invalid

**Example:**

```json
{
   "success": false,
   "error": {
      "code": "CONFLICT",
      "message": "Creator handle already exists"
   }
}
```

---

### BAD_REQUEST

**HTTP Status:** 400 Bad Request

**Meaning:** The request is malformed or contains invalid data that cannot be processed.

**When to use:**

- Request body is not valid JSON
- Request payload exceeds size limits
- Required path parameters are missing
- Query parameters are malformed (but not validation errors)

**Example:**

```json
{
   "success": false,
   "error": {
      "code": "BAD_REQUEST",
      "message": "Request payload too large"
   }
}
```

---

### INTERNAL_ERROR

**HTTP Status:** 500 Internal Server Error

**Meaning:** An unexpected error occurred on the server.

**When to use:**

- Unhandled exceptions
- Database connection failures
- External service failures
- Timeout errors
- Any error that cannot be categorized as a client error

**Example:**

```json
{
   "success": false,
   "error": {
      "code": "INTERNAL_ERROR",
      "message": "Internal server error"
   }
}
```

---

### RATE_LIMIT

**HTTP Status:** 429 Too Many Requests

**Meaning:** The client has exceeded the rate limit for this endpoint.

**When to use:**

- Client has made too many requests in a time window
- Rate limiting middleware has rejected the request

**Example:**

```json
{
   "success": false,
   "error": {
      "code": "RATE_LIMIT",
      "message": "Too many requests. Please try again later."
   }
}
```

---

### DATABASE_ERROR (PRISMA_ERROR)

**HTTP Status:** 400 Bad Request

**Meaning:** A database operation failed.

**When to use:**

- Prisma errors (P2002, P2025, P2003, etc.)
- Database constraint violations
- Foreign key violations
- Record not found in database

**Example:**

```json
{
   "success": false,
   "error": {
      "code": "DATABASE_ERROR",
      "message": "Record already exists (unique constraint violation)"
   }
}
```

---

### TOKEN_ERROR (JWT_ERROR)

**HTTP Status:** 401 Unauthorized

**Meaning:** JWT token validation failed.

**When to use:**

- JWT token is invalid or malformed
- JWT token has expired
- JWT signature verification failed

**Example:**

```json
{
   "success": false,
   "error": {
      "code": "TOKEN_ERROR",
      "message": "Token has expired"
   }
}
```

---

## Adding New Error Codes

### When to Add a New Code

Add a new error code **only** when:

1. **No existing code fits the error condition.** Review the registry above to ensure an existing code cannot be reused.
2. **The error is a distinct, recoverable client condition.** Transient server errors should use `INTERNAL_ERROR`.
3. **Clients need to handle this error differently.** If clients would handle it the same way as an existing code, reuse the existing code.
4. **The error is stable and will not change.** Error codes are part of the public API contract.

### When NOT to Add a New Code

Do **not** add a new code if:

- The error is a variant of an existing code (e.g., "CREATOR_NOT_FOUND" vs "NOT_FOUND"). Use the existing code with a descriptive message instead.
- The error is transient or internal (e.g., "CACHE_MISS", "RETRY_NEEDED"). Use `INTERNAL_ERROR`.
- The error is specific to a single endpoint or feature. Use an existing code and vary the message.
- The error is a database-specific error. Use `DATABASE_ERROR` and include details in the message.

### How to Add a New Code

1. **Add the constant** to `src/constants/error.constants.ts`:

   ```typescript
   export const ErrorCode = {
      // ... existing codes
      NEW_ERROR_CODE: 'NEW_ERROR_CODE',
   } as const;
   ```

2. **Document the code** in this registry with:
   - HTTP status code
   - Clear meaning
   - When to use (with examples)
   - Example error response

3. **Update error handling** in relevant middleware or handlers to use the new code.

4. **Add tests** that verify the new code is returned in the appropriate error conditions.

5. **Update this document** with the new code entry.

### Example: Adding a New Code

**Scenario:** You need a distinct error code for when a creator's profile is incomplete and cannot be published.

**Decision:** This is a client error (incomplete data), distinct from validation errors (schema violations), and clients need to handle it differently (prompt user to complete profile vs. show validation errors). Add a new code.

**Implementation:**

1. Add to `error.constants.ts`:

   ```typescript
   export const ErrorCode = {
      // ... existing codes
      INCOMPLETE_PROFILE: 'INCOMPLETE_PROFILE',
   } as const;
   ```

2. Document in this registry:

   ```markdown
   ### INCOMPLETE_PROFILE

   **HTTP Status:** 400 Bad Request

   **Meaning:** The creator profile is missing required fields and cannot be published.

   **When to use:**

   - Attempting to publish a profile with missing required fields
   - Profile lacks required information (bio, avatar, etc.)
   ```

3. Use in handler:

   ```typescript
   if (!profile.bio || !profile.avatarUrl) {
      return sendError(
         res,
         400,
         ErrorCode.INCOMPLETE_PROFILE,
         'Profile is incomplete'
      );
   }
   ```

4. Add test:
   ```typescript
   it('returns INCOMPLETE_PROFILE when bio is missing', async () => {
      const res = await publishProfile({ avatarUrl: 'url' });
      expect(res.body.error.code).toBe(ErrorCode.INCOMPLETE_PROFILE);
   });
   ```

## Error Code Stability

Error codes are part of the public API contract and should be treated as stable:

- **Do not rename** existing codes. If a code needs to be renamed, create a new code and deprecate the old one.
- **Do not remove** codes. If a code is no longer used, mark it as deprecated in comments but keep it defined.
- **Do not change HTTP status codes** for existing codes. If the status code needs to change, create a new code.
- **Do not change meanings** of existing codes. If the meaning needs to change, create a new code.

## Related Documentation

- [API Error Handling](./architecture/route-error-mapping.md) - Error handling architecture
- [Error Constants](../src/constants/error.constants.ts) - Error code definitions
- [API Response Utilities](../src/utils/api-response.utils.ts) - Helper functions for sending errors
- [Rate Limiting](./rate-limiting.md) - Rate limiting configuration and thresholds
