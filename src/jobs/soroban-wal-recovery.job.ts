import { logger } from '../utils/logger.utils';
import { HorizonSorobanGateway } from '../modules/soroban-wal/horizon-soroban-gateway';
import { PrismaSorobanWALStore } from '../modules/soroban-wal/prisma-soroban-wal.store';
import { SorobanWALService } from '../modules/soroban-wal/soroban-wal.service';
import { applyDefaultSorobanSideEffects } from '../modules/soroban-wal/soroban-wal-side-effects';

const RECOVERY_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 30_000;

const recoveryService = new SorobanWALService(
   new PrismaSorobanWALStore(),
   new HorizonSorobanGateway()
);

let recoveryTimer: NodeJS.Timeout | null = null;
let recoveryRunning = false;

export async function recoverStaleSorobanTransactions(
   now = new Date()
): Promise<number> {
   const olderThan = new Date(now.getTime() - STALE_AFTER_MS);
   const recovered = await recoveryService.recover(
      olderThan,
      applyDefaultSorobanSideEffects
   );
   return recovered.length;
}

export function startSorobanWALRecoveryJob(): void {
   if (recoveryTimer) return;

   const run = async () => {
      if (recoveryRunning) return;
      recoveryRunning = true;
      try {
         const recoveredEntries = await recoverStaleSorobanTransactions();
         if (recoveredEntries > 0) {
            logger.info(
               { recoveredEntries },
               'Soroban WAL recovery pass completed'
            );
         }
      } catch (error) {
         logger.error({ error }, 'Soroban WAL recovery pass failed');
      } finally {
         recoveryRunning = false;
      }
   };

   void run();
   recoveryTimer = setInterval(() => void run(), RECOVERY_INTERVAL_MS);
   recoveryTimer.unref?.();
   logger.info('Soroban WAL recovery job started');
}

export function stopSorobanWALRecoveryJob(): void {
   if (!recoveryTimer) return;
   clearInterval(recoveryTimer);
   recoveryTimer = null;
   logger.info('Soroban WAL recovery job stopped');
}
