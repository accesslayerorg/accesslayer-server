// src/jobs/liquidation-keeper.job.ts
// Submits `liquidate` for lending positions whose health has dropped below 1.
//
// Candidates come from the health monitor's vault_health rows, but each is
// re-verified against the chain immediately before submission: a position the
// keeper — or a competing keeper — already liquidated reads back with no open
// position (null) and is skipped. Liquidations run with bounded concurrency so
// a batch of unhealthy positions cannot flood the RPC.

import { envConfig } from '../config';
import { logger } from '../utils/logger.utils';
import { prisma } from '../utils/prisma.utils';
import { LIQUIDATION_HEALTH_THRESHOLD } from '../modules/vault/vault-health.service';
import {
   readVaultHealthOnChain,
   submitLiquidate,
} from '../modules/vault/vault-lending.contract';

/** Liquidations in flight before waiting for the batch to settle. */
export const MAX_CONCURRENT_LIQUIDATIONS = 3;

const KEEPER_INTERVAL_MS = 30_000;

export interface LiquidationKeeperDeps {
   now?: () => Date;
   /** Re-read health from chain; null = closed, already liquidated, or unknown. */
   checkOnChainHealth?: (wallet: string) => Promise<number | null>;
   /** Submit the liquidate call for a position. */
   liquidate?: (position: { id: string; wallet: string }) => Promise<void>;
   /** Max liquidations in flight at once. */
   concurrency?: number;
}

export interface LiquidationPassResult {
   considered: number;
   liquidated: number;
   skipped: number;
   failed: number;
}

/** One keeper pass over the unhealthy positions recorded by the monitor. */
export async function runLiquidationPass(
   deps: LiquidationKeeperDeps = {}
): Promise<LiquidationPassResult> {
   const now = deps.now ?? (() => new Date());
   const checkOnChainHealth = deps.checkOnChainHealth ?? readVaultHealthOnChain;
   const liquidate = deps.liquidate ?? (position => submitLiquidate(position.wallet));
   const concurrency = Math.max(
      1,
      deps.concurrency ?? MAX_CONCURRENT_LIQUIDATIONS
   );

   const unhealthy = await prisma.vaultHealth.findMany({
      where: { healthFactor: { lt: LIQUIDATION_HEALTH_THRESHOLD } },
      include: { position: true },
   });
   const candidates = unhealthy.filter(
      row => row.position.liquidatedAt === null
   );

   const result: LiquidationPassResult = {
      considered: candidates.length,
      liquidated: 0,
      skipped: 0,
      failed: 0,
   };

   for (let i = 0; i < candidates.length; i += concurrency) {
      const batch = candidates.slice(i, i + concurrency);
      await Promise.all(
         batch.map(async row => {
            try {
               const onChain = await checkOnChainHealth(row.wallet);
               if (onChain === null || onChain >= LIQUIDATION_HEALTH_THRESHOLD) {
                  result.skipped += 1;
                  return;
               }

               await liquidate({ id: row.positionId, wallet: row.wallet });
               await prisma.lendingPosition.update({
                  where: { id: row.positionId },
                  data: { liquidatedAt: now() },
               });
               result.liquidated += 1;
            } catch (error) {
               result.failed += 1;
               logger.warn(
                  {
                     positionId: row.positionId,
                     wallet: row.wallet,
                     err: (error as Error).message,
                  },
                  'liquidation-keeper: liquidation failed'
               );
            }
         })
      );
   }

   logger.info(result, 'liquidation-keeper: pass completed');
   return result;
}

let keeperTimer: ReturnType<typeof setInterval> | null = null;

export function startLiquidationKeeper(): void {
   if (!envConfig.VAULT_LIQUIDATION_KEEPER_ENABLED) {
      logger.info('liquidation-keeper is disabled');
      return;
   }

   const run = async () => {
      try {
         await runLiquidationPass();
      } catch (error) {
         logger.error(
            { err: error },
            'liquidation-keeper failed with an unexpected error'
         );
      }
   };

   void run();
   keeperTimer = setInterval(() => {
      void run();
   }, KEEPER_INTERVAL_MS);

   if (typeof keeperTimer.unref === 'function') {
      keeperTimer.unref();
   }

   logger.info(
      { intervalMs: KEEPER_INTERVAL_MS },
      'liquidation-keeper started'
   );
}

export function stopLiquidationKeeper(): void {
   if (keeperTimer) {
      clearInterval(keeperTimer);
      keeperTimer = null;
   }
   logger.info('liquidation-keeper stopped');
}
