// src/lib/single-flight.ts

export interface SingleFlightMetrics {
  coalescedRequests?: (count?: number) => void;
  waitDuration?: (seconds: number) => void;
}

export interface SingleFlightOptions {
  timeoutMs?: number;
  metrics?: SingleFlightMetrics;
}

interface Flight<T> {
  promise: Promise<T>;
  startedAt: number;
}

interface CachedValue<T> {
  value: T;
  expiresAt: number;
}

const flights = new Map<string, Flight<unknown>>();
const cache = new Map<string, CachedValue<unknown>>();

const DEFAULT_TTL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 10_000;

export class SingleFlightTimeoutError extends Error {
  constructor() {
    super("Shared read operation timed out.");
    this.name = "SingleFlightTimeoutError";
  }
}

export async function singleFlight<T>(
  key: string,
  fn: (signal: AbortSignal) => Promise<T>,
  ttlMs = DEFAULT_TTL_MS,
  options: SingleFlightOptions = {},
): Promise<T> {
  if (!key || !key.trim()) {
    throw new Error("Single-flight key is required.");
  }

  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new Error("Single-flight TTL must be non-negative.");
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Single-flight timeout must be positive.");
  }

  const now = Date.now();

  // Return a valid cached result.
  const cached = cache.get(key) as CachedValue<T> | undefined;

  if (cached) {
    if (cached.expiresAt > now) {
      return cached.value;
    }

    cache.delete(key);
  }

  // Join an existing in-flight request.
  const existing = flights.get(key) as Flight<T> | undefined;

  if (existing) {
    options.metrics?.coalescedRequests?.(1);

    const waitStartedAt = Date.now();

    try {
      return await existing.promise;
    } finally {
      options.metrics?.waitDuration?.(
        (Date.now() - waitStartedAt) / 1_000,
      );
    }
  }

  const controller = new AbortController();
  let timedOut = false;

  const work = Promise.resolve().then(() => fn(controller.signal));

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new SingleFlightTimeoutError());
    }, timeoutMs);
  });

  const flight: Flight<T> = {
    startedAt: now,
    promise: Promise.race([work, timeout])
      .then((result) => {
        // Only the current, non-expired leader may populate the cache.
        if (!timedOut && flights.get(key) === flight) {
          if (ttlMs > 0) {
            cache.set(key, {
              value: result,
              expiresAt: Date.now() + ttlMs,
            });
          }
        }

        return result;
      })
      .finally(() => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        // Don't delete a newer leader created after this one timed out.
        if (flights.get(key) === flight) {
          flights.delete(key);
        }
      }),
  };

  flights.set(key, flight as Flight<unknown>);

  return flight.promise;
}