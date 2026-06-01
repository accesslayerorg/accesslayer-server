# Route-safe unknown error mapping

The global error middleware (`src/middlewares/error.middleware.ts`) routes
known errors (Zod validation, JWT, Prisma, `ApiError`, payload-too-large,
malformed JSON) through dedicated branches that already produce the right
status code, error code and message.

For everything else — an unhandled `throw`, a third-party library exception,
a programming bug — the fallback path delegates to
`mapUnknownRouteError()` in `src/utils/route-error.utils.ts`.

## Why a shared helper

- One place to evolve the unknown-error envelope shape.
- Guaranteed inclusion of the route context id (`req.requestId`) so an
  operator can correlate a 500 response with server-side logs.
- Production responses never leak `error.message`, `stack`, or the raw
  error object. Development responses include them for local debugging.

## Envelope shape

Production:

```json
{
   "success": false,
   "code": "INTERNAL_ERROR",
   "message": "Internal server error",
   "requestId": "8c4d…"
}
```

Development additionally includes `stack` and `error` for fast iteration.

## What the helper does NOT do

It is the **fallback only**. Validation errors, auth errors, Prisma errors
and explicit `ApiError` instances continue to be mapped by their dedicated
branches in the global middleware. Do not reach for this helper to wrap a
known-shape error — throw an `ApiError` (or one of the helpers in
`error.middleware.ts`) instead.
