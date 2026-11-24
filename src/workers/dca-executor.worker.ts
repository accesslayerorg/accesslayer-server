// src/workers/dca-executor.worker.ts
// Recurring purchase (DCA) plan executor worker (#1322).

import { prisma } from '../utils/prisma.utils';
import { logger } from '../utils/logger.utils';
import {
   computeNextRunAt,
   DcaFrequency,
} from '../modules/dca/dca.service';
import { emitDcaPaused } from '../modules/dca/dca.events';

export const DCA_MAX_CONSECUTIVE_FAILURES = 3;
export const DCA_DEFAULT_BATCH_SIZE = 50;
export const DCA_DEFAULT_INTERVAL_MS = 15_000;

export interface DueDcaPlan {
   id: string;
   wallet: string;
   keyId: string;
   amount: bigint;
   frequency: string;
   nextRunAt: Date;
   budgetRemaining: bigint;
   status: string;
   maxSlippageBps: number;
   spendingAuth: string | null;
   consecutiveFailures: number;
}

export interface DcaExecutionClient {
   /** Returns available wallet balance in stroops. */
   getWalletBalance(wallet: string): Promise<bigint>;
   /** Returns current spot/quoted slippage in basis points for buying `amount` of `keyId`. */
   getSlippageBps(keyId: string, amount: bigint): Promise<number>;
   /** Builds and submits a buy transaction using the pre-signed spending authorization. */
   executeBuyWithAuth(plan: DueDcaPlan): Promise<{
      txHash: string;
      txXdr: string;
      amountSpent: bigint;
   }>;
}

export class DcaExecutorWorker {
   private timer: NodeJS.Timeout | null = null;
   private running = false;
   private readonly now: () => Date;
   private readonly batchSize: number;

   constructor(
      private readonly client: DcaExecutionClient,
      options?: { now?: () => Date; batchSize?: number }
   ) {
      this.now = options?.now ?? (() => new Date());
      this.batchSize = options?.batchSize ?? DCA_DEFAULT_BATCH_SIZE;
   }

   start(intervalMs = DCA_DEFAULT_INTERVAL_MS): void {
      if (this.running) return;
      this.running = true;
      this.timer = setInterval(() => {
         void this.tick();
      }, intervalMs);
   }

   stop(): void {
      if (this.timer) {
         clearInterval(this.timer);
         this.timer = null;
      }
      this.running = false;
   }

   /**
    * Selects due active plans using `FOR UPDATE SKIP LOCKED` inside a
    * transaction and processes each plan idempotently per (planId, scheduledFor).
    */
   async tick(): Promise<number> {
      const now = this.now();
      const duePlans = await prisma.$transaction(async tx => {
         const rows = await tx.$queryRaw<DueDcaPlan[]>`
            SELECT id, wallet, "keyId", amount, frequency, "nextRunAt",
                   "budgetRemaining", status, "maxSlippageBps", "spendingAuth",
                   "consecutiveFailures"
            FROM "dca_plans"
            WHERE status = 'active' AND "nextRunAt" <= ${now}
            ORDER BY "nextRunAt" ASC
            LIMIT ${this.batchSize}
            FOR UPDATE SKIP LOCKED
         `;

         for (const plan of rows) {
            await this.processPlan(tx, plan, now);
         }
         return rows;
      });

      return duePlans.length;
   }

   private async processPlan(
      tx: Pick<typeof prisma, 'dcaPlan' | 'dcaRun'>,
      plan: DueDcaPlan,
      now: Date
   ): Promise<void> {
      const scheduledFor = new Date(plan.nextRunAt);
      const nextRunAt = computeNextRunAt(
         scheduledFor,
         plan.frequency as DcaFrequency
      );

      // Idempotency guard per (planId, scheduledFor)
      const existingRun = await tx.dcaRun.findUnique({
         where: {
            planId_scheduledFor: {
               planId: plan.id,
               scheduledFor,
            },
         },
      });
      if (existingRun) {
         return;
      }

      // 1. Remaining budget check
      if (plan.budgetRemaining < plan.amount) {
         await tx.dcaRun.create({
            data: {
               planId: plan.id,
               scheduledFor,
               status: 'skipped',
               reason: 'insufficient_budget',
            },
         });
         await tx.dcaPlan.update({
            where: { id: plan.id },
            data: {
               nextRunAt,
               ...(plan.budgetRemaining <= 0n ? { status: 'completed' } : {}),
            },
         });
         return;
      }

      // 2. Wallet balance check
      let balance: bigint;
      try {
         balance = await this.client.getWalletBalance(plan.wallet);
      } catch (error) {
         await this.recordFailure(tx, plan, scheduledFor, nextRunAt, now, error);
         return;
      }

      if (balance < plan.amount) {
         await tx.dcaRun.create({
            data: {
               planId: plan.id,
               scheduledFor,
               status: 'skipped',
               reason: 'insufficient_balance',
            },
         });
         await tx.dcaPlan.update({
            where: { id: plan.id },
            data: { nextRunAt },
         });
         return;
      }

      // 3. Slippage check
      let slippageBps: number;
      try {
         slippageBps = await this.client.getSlippageBps(plan.keyId, plan.amount);
      } catch (error) {
         await this.recordFailure(tx, plan, scheduledFor, nextRunAt, now, error);
         return;
      }

      if (slippageBps > plan.maxSlippageBps) {
         await tx.dcaRun.create({
            data: {
               planId: plan.id,
               scheduledFor,
               status: 'skipped',
               reason: 'slippage_exceeded',
            },
         });
         await tx.dcaPlan.update({
            where: { id: plan.id },
            data: { nextRunAt },
         });
         return;
      }

      // 4. Pre-signed spending authorization check & execution
      if (!plan.spendingAuth) {
         await tx.dcaRun.create({
            data: {
               planId: plan.id,
               scheduledFor,
               status: 'skipped',
               reason: 'missing_spending_auth',
            },
         });
         await tx.dcaPlan.update({
            where: { id: plan.id },
            data: { nextRunAt },
         });
         return;
      }

      try {
         const exec = await this.client.executeBuyWithAuth(plan);
         const newBudget =
            plan.budgetRemaining > exec.amountSpent
               ? plan.budgetRemaining - exec.amountSpent
               : 0n;

         await tx.dcaRun.create({
            data: {
               planId: plan.id,
               scheduledFor,
               status: 'executed',
               amountSpent: exec.amountSpent,
               txHash: exec.txHash,
               txXdr: exec.txXdr,
            },
         });

         await tx.dcaPlan.update({
            where: { id: plan.id },
            data: {
               budgetRemaining: newBudget,
               consecutiveFailures: 0,
               nextRunAt,
               ...(newBudget === 0n ? { status: 'completed' } : {}),
            },
         });
      } catch (error) {
         await this.recordFailure(tx, plan, scheduledFor, nextRunAt, now, error);
      }
   }

   private async recordFailure(
      tx: Pick<typeof prisma, 'dcaPlan' | 'dcaRun'>,
      plan: DueDcaPlan,
      scheduledFor: Date,
      nextRunAt: Date,
      now: Date,
      error: unknown
   ): Promise<void> {
      const reason = error instanceof Error ? error.message : String(error);
      const newFailures = plan.consecutiveFailures + 1;
      const shouldPause = newFailures >= DCA_MAX_CONSECUTIVE_FAILURES;

      await tx.dcaRun.create({
         data: {
            planId: plan.id,
            scheduledFor,
            status: 'failed',
            reason,
         },
      });

      await tx.dcaPlan.update({
         where: { id: plan.id },
         data: {
            consecutiveFailures: newFailures,
            nextRunAt,
            ...(shouldPause ? { status: 'paused' } : {}),
         },
      });

      if (shouldPause) {
         logger.warn(
            { planId: plan.id, wallet: plan.wallet, consecutiveFailures: newFailures },
            'Pausing DCA plan after 3 consecutive failures'
         );
         emitDcaPaused({
            planId: plan.id,
            wallet: plan.wallet,
            keyId: plan.keyId,
            consecutiveFailures: newFailures,
            reason,
            pausedAt: now.toISOString(),
         });
      }
   }
}
