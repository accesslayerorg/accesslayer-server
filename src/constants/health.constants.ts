/**
 * Maximum acceptable response time for the liveness health endpoint
 * (`GET /api/v1/health`) in the test environment.
 *
 * The budget is intentionally generous to avoid flaky CI while still catching
 * regressions where heavy work is accidentally added to the hot path.
 */
export const HEALTH_LIVENESS_MAX_LATENCY_MS = 100;
