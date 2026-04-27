# API and Schema Versioning

The Access Layer Server uses versioning headers to inform clients about the current API version and the expected structure of request bodies.

## Response Headers

### `X-API-Version`
Indicates the current overall version of the API. This is typically used for tracking feature sets and major API releases.

### `X-Schema-Version`
Indicates the active version of the request body schema. This version should be checked by consumers to ensure they are sending request bodies in the format expected by the server.

## Versioning Strategy

Both headers follow [Semantic Versioning (SemVer)](https://semver.org/):
- **MAJOR** version: Breaking changes to the API or schema.
- **MINOR** version: Backwards-compatible new features or additions.
- **PATCH** version: Backwards-compatible bug fixes.

## Expected Consumer Behavior

1. **Check Headers**: Consumers should inspect the `X-Schema-Version` header in API responses.
2. **Schema Alignment**: If the `X-Schema-Version` major version changes, consumers must update their request body structures to match the new schema requirements.
3. **Warning Handling**: Consumers may choose to log warnings if they detect a version mismatch that they haven't yet updated to support.
