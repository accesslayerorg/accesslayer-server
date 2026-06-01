// src/utils/monotonic-clock.utils.ts

/**
 * Opaque handle returned by `startTimer`. Pass it to `elapsedMs` to get
 * the duration. Using a branded type prevents mixing up raw hrtime tuples.
 */
export type TimerHandle = { readonly _hrtime: [number, number] };

/**
 * Starts a monotonic timer using `process.hrtime`.
 *
 * Unlike `Date.now()`, `process.hrtime` is not affected by system clock
 * adjustments, making it reliable for latency measurements.
 *
 * @example
 * const t = startTimer();
 * await doWork();
 * const ms = elapsedMs(t); // e.g. 42.317
 */
export function startTimer(): TimerHandle {
   return { _hrtime: process.hrtime() };
}

/**
 * Returns the elapsed time in milliseconds (floating-point) since the
 * timer was started with `startTimer`.
 *
 * @param handle - The handle returned by `startTimer`.
 */
export function elapsedMs(handle: TimerHandle): number {
   const diff = process.hrtime(handle._hrtime);
   return diff[0] * 1e3 + diff[1] * 1e-6;
}

/**
 * Returns the elapsed time as a formatted string rounded to 3 decimal places.
 * Matches the format already used by `X-Response-Time` in this codebase.
 *
 * @example
 * elapsedMsFormatted(t); // "42.317ms"
 */
export function elapsedMsFormatted(handle: TimerHandle): string {
   return `${elapsedMs(handle).toFixed(3)}ms`;
}
