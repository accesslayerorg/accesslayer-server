/**
 * Computes the next retry delay using exponential backoff with jitter.
 *
 * Formula: delay = min(baseMs * 2^attempt, maxMs) + random(0, 0.2 * computed_delay)
 * The final delay is capped at maxMs.
 *
 * @param attempt - The current retry attempt (0-indexed).
 * @param baseMs - The base delay in milliseconds.
 * @param maxMs - The maximum allowed delay.
 * @returns The calculated delay in milliseconds.
 */
export function computeRetryDelay(
   attempt: number,
   baseMs: number,
   maxMs: number
): number {
   const exponentialDelay = baseMs * Math.pow(2, attempt);
   const computedDelay = Math.min(exponentialDelay, maxMs);

   // Add up to 20% jitter to the computed delay
   const jitter = Math.random() * (0.2 * computedDelay);

   // Ensure the final delay with jitter never exceeds maxMs
   return Math.floor(Math.min(computedDelay + jitter, maxMs));
}
