import { getRedis } from './redis.utils';
import { logger } from './logger.utils';

const LOCK_TTL_SECONDS = 15;
const LOCK_ACQUIRE_TIMEOUT_MS = 8_000;
const LOCK_RENEWAL_INTERVAL_MS = 5_000;
const LOCK_RETRY_DELAY_MS = 100;

export class SequencerContentionError extends Error {
   public readonly code = 'sequencer_contention';

   constructor(message: string) {
      super(message);
      this.name = 'SequencerContentionError';
   }
}

function lockKey(creatorWallet: string): string {
   return `seq_lock:${creatorWallet}`;
}

export async function acquireSequencerLock(
   creatorWallet: string
): Promise<{ release: () => Promise<void> }> {
   const redis = getRedis();

   if (!redis) {
      // Redis caching is disabled: degrade to a no-op lock so single-instance
      // operation continues without distributed coordination.
      return { release: async () => {} };
   }


   const key = lockKey(creatorWallet);
   const lockValue = `${process.pid}:${Date.now()}`;
   const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;

   while (Date.now() < deadline) {
      const acquired = await redis.set(key, lockValue, 'EX', LOCK_TTL_SECONDS, 'NX');

      if (acquired === 'OK') {
         let renewalInterval: ReturnType<typeof setInterval> | null = null;

         renewalInterval = setInterval(async () => {
            try {
               const current = await redis.get(key);
               if (current === lockValue) {
                  await redis.expire(key, LOCK_TTL_SECONDS);
               }
            } catch {
               // renewal failure is non-fatal; the TTL provides a safety net
            }
         }, LOCK_RENEWAL_INTERVAL_MS);

         if (renewalInterval.unref) {
            renewalInterval.unref();
         }

         const release = async () => {
            if (renewalInterval) {
               clearInterval(renewalInterval);
               renewalInterval = null;
            }
            try {
               const current = await redis.get(key);
               if (current === lockValue) {
                  await redis.del(key);
               }
            } catch (err) {
               logger.warn(
                  { creator_wallet: creatorWallet, err },
                  'Failed to release sequencer lock'
               );
            }
         };

         return { release };
      }

      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
   }

   throw new SequencerContentionError(
      `Could not acquire sequencer lock for ${creatorWallet} within ${LOCK_ACQUIRE_TIMEOUT_MS}ms`
   );
}
