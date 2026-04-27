import { envConfig } from '../config';

/**
 * Applies random jitter to a base delay to prevent "thundering herd" issues.
 *
 * Formula: delay = baseDelay * (1 + random(-jitterFactor, jitterFactor))
 *
 * @param baseDelayMs - The base delay in milliseconds.
 * @param jitterFactor - The maximum percentage of jitter to apply (0.0 to 1.0). Defaults to 0.1 (10%).
 * @returns The delay with jitter applied.
 */
export function applyJitter(
   baseDelayMs: number,
   jitterFactor: number = envConfig.INDEXER_JITTER_FACTOR
): number {
   const min = 1 - jitterFactor;
   const max = 1 + jitterFactor;
   const multiplier = Math.random() * (max - min) + min;
   return Math.floor(baseDelayMs * multiplier);
}

/**
 * Calculates a backoff delay with jitter.
 *
 * Useful for retry loops where each subsequent failure should wait longer
 * before retrying, but with random variance to avoid synchronization.
 *
 * @param attempt - The current retry attempt (0-indexed).
 * @param baseDelayMs - The initial delay in milliseconds.
 * @param maxDelayMs - The maximum allowed delay.
 * @param jitterFactor - The amount of jitter to apply.
 * @returns The calculated delay in milliseconds.
 */
export function getBackoffWithJitter(
   attempt: number,
   baseDelayMs: number = 1000,
   maxDelayMs: number = 30000,
   jitterFactor: number = envConfig.INDEXER_JITTER_FACTOR
): number {
   const backoff = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
   return applyJitter(backoff, jitterFactor);
}
