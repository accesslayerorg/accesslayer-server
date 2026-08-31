import { getRedis } from './redis.utils';
import { logger } from './logger.utils';

export class SupplyDriftHaltedError extends Error {
   public readonly code = 'supply_drift_halted';

   constructor(message: string) {
      super(message);
      this.name = 'SupplyDriftHaltedError';
   }
}

function driftKey(creatorWallet: string): string {
   return `drift:${creatorWallet}`;
}

export async function isDriftHalted(creatorWallet: string): Promise<boolean> {
   const redis = getRedis();
   if (!redis) return false;
   const exists = await redis.exists(driftKey(creatorWallet));
   return exists === 1;
}

export async function assertNoSupplyDrift(creatorWallet: string): Promise<void> {
   const halted = await isDriftHalted(creatorWallet);
   if (halted) {
      throw new SupplyDriftHaltedError(
         `Operations halted for creator ${creatorWallet} due to detected supply drift`
      );
   }
}

export async function verifySupplyAndGuard(
   creatorWallet: string,
   expectedSupply: number,
   actualSupply: number
): Promise<boolean> {
   if (expectedSupply !== actualSupply) {
      logger.error(
         {
            event: 'supply_drift_detected',
            creator_wallet: creatorWallet,
            expected_supply: expectedSupply,
            actual_supply: actualSupply,
         },
         'Supply drift detected! Operations halted for creator until cleared.'
      );

      const redis = getRedis();

      if (!redis) return false;
      await redis.set(driftKey(creatorWallet), '1');

      if (redis) {
         await redis.set(driftKey(creatorWallet), '1');
      }

      return false;
   }

   return true;
}

export async function clearDrift(creatorWallet: string): Promise<void> {
   const redis = getRedis();
   if (!redis) return;
   await redis.del(driftKey(creatorWallet));
   logger.info(
      { creator_wallet: creatorWallet },
      'Supply drift flag cleared for creator'
   );
}
