// src/modules/indexer/backfill/backfill-throttle.ts
// Token-bucket throttle for backfill RPC traffic. Keeps a backfill from using
// the whole RPC pool and starving the live indexer (#1337).

export interface Throttle {
   /** Resolves when the caller may issue one more request. */
   take(): Promise<void>;
}

export interface ThrottleOptions {
   /** Sustained requests per second. */
   requestsPerSecond: number;
   /** Requests allowed in a burst. Defaults to one second's worth. */
   burst?: number;
   now?: () => number;
   sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function createThrottle(options: ThrottleOptions): Throttle {
   if (!(options.requestsPerSecond > 0)) {
      throw new Error('requestsPerSecond must be greater than zero');
   }

   const ratePerMs = options.requestsPerSecond / 1000;
   const capacity = options.burst ?? Math.max(1, options.requestsPerSecond);
   const now = options.now ?? Date.now;
   const sleep = options.sleep ?? defaultSleep;

   let tokens = capacity;
   let updatedAt = now();

   const refill = () => {
      const current = now();
      tokens = Math.min(capacity, tokens + (current - updatedAt) * ratePerMs);
      updatedAt = current;
   };

   return {
      async take() {
         // Serialise callers implicitly: each waits for its own token deficit.
         for (;;) {
            refill();
            if (tokens >= 1) {
               tokens -= 1;
               return;
            }
            const waitMs = Math.ceil((1 - tokens) / ratePerMs);
            await sleep(waitMs);
         }
      },
   };
}
