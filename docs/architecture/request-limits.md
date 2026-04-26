# Request Body Size Limits

The API uses configurable request body size limits to prevent abuse (like large payload attacks) while still allowing necessary bulk operations where needed. Rather than applying a single global body size limit to all routes, the application uses route-specific limits grouped by functional area.

## Configuration Defaults and Overrides

Limits are configured via environment variables. The following variables control the maximum payload size for JSON and URL-encoded requests:

| Environment Variable     | Default Limit | Target Route Group                                               |
| ------------------------ | ------------- | ---------------------------------------------------------------- |
| `MAX_BODY_SIZE_DEFAULT`  | `1mb`         | Used for standard routes (`/auth`, `/health`, `/activity`, etc.) |
| `MAX_BODY_SIZE_CREATORS` | `5mb`         | Used for creator-specific routes.                                |
| `MAX_BODY_SIZE_ADMIN`    | `10mb`        | Used for administrative routes (e.g. bulk data uploads).         |

### Overriding Limits

To override a limit, simply provide the appropriate environment variable in your `.env` file or environment configuration.

```env
# Example overrides in .env
MAX_BODY_SIZE_DEFAULT=2mb
MAX_BODY_SIZE_ADMIN=50mb
MAX_BODY_SIZE_CREATORS=10mb
```

Valid values include sizes with unit suffixes (e.g., `100kb`, `1mb`, `5mb`) which are parsed by the `bytes` library used internally by Express `body-parser`.

## Adding Custom Limits for New Route Groups

To introduce a distinct size limit for a new set of routes:

1. **Define Configuration:** Add a new configuration property in `src/config.ts` under the `envSchema` (e.g., `MAX_BODY_SIZE_CUSTOM`).
2. **Create Middleware:** In `src/middlewares/body-parser.middleware.ts`, export a new parser using the helper function `createBodyParser(envConfig.MAX_BODY_SIZE_CUSTOM)`.
3. **Apply to Router:** In `src/modules/index.ts`, apply the new exported middleware to the relevant `router.use()` definition.

## Error Handling

When a client sends a payload that exceeds the configured limit for the route group, the server intercepts the process early and fails fast without fully consuming the body. It will return a standard API error response with HTTP `413 Payload Too Large`:

```json
{
   "success": false,
   "code": "PAYLOAD_TOO_LARGE",
   "message": "Request body exceeds configured size limit"
}
```
