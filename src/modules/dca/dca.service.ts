// src/modules/dca/dca.service.ts
// Recurring purchase (DCA) plan management service (#1322).

import { prisma } from '../../utils/prisma.utils';

export type DcaFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly';

export const FREQUENCY_INTERVAL_MS: Record<DcaFrequency, number> = {
   hourly: 60 * 60 * 1000,
   daily: 24 * 60 * 60 * 1000,
   weekly: 7 * 24 * 60 * 60 * 1000,
   monthly: 30 * 24 * 60 * 60 * 1000,
};

export class DcaPlanNotFoundError extends Error {
   constructor(id: string) {
      super(`DCA plan not found: ${id}`);
      this.name = 'DcaPlanNotFoundError';
   }
}

export class DcaPlanForbiddenError extends Error {
   constructor() {
      super('You do not own this DCA plan');
      this.name = 'DcaPlanForbiddenError';
   }
}

export function computeNextRunAt(from: Date, frequency: DcaFrequency): Date {
   const interval = FREQUENCY_INTERVAL_MS[frequency] ?? FREQUENCY_INTERVAL_MS.daily;
   return new Date(from.getTime() + interval);
}

function serializePlan(plan: {
   id: string;
   wallet: string;
   keyId: string;
   amount: bigint;
   frequency: string;
   nextRunAt: Date;
   budgetRemaining: bigint;
   status: string;
   maxSlippageBps: number;
   consecutiveFailures: number;
   createdAt: Date;
   updatedAt: Date;
}) {
   return {
      id: plan.id,
      wallet: plan.wallet,
      keyId: plan.keyId,
      amount: plan.amount.toString(),
      frequency: plan.frequency,
      nextRunAt: plan.nextRunAt.toISOString(),
      budgetRemaining: plan.budgetRemaining.toString(),
      status: plan.status,
      maxSlippageBps: plan.maxSlippageBps,
      consecutiveFailures: plan.consecutiveFailures,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
   };
}

export class DcaService {
   async createPlan(
      wallet: string,
      input: {
         keyId: string;
         amount: bigint;
         frequency: DcaFrequency;
         budgetRemaining: bigint;
         maxSlippageBps: number;
         nextRunAt?: Date;
         spendingAuth?: string;
      }
   ) {
      const nextRunAt =
         input.nextRunAt ?? computeNextRunAt(new Date(), input.frequency);

      const plan = await prisma.dcaPlan.create({
         data: {
            wallet,
            keyId: input.keyId,
            amount: input.amount,
            frequency: input.frequency,
            nextRunAt,
            budgetRemaining: input.budgetRemaining,
            status: 'active',
            maxSlippageBps: input.maxSlippageBps,
            spendingAuth: input.spendingAuth ?? null,
         },
      });

      return serializePlan(plan);
   }

   async updatePlan(
      wallet: string,
      id: string,
      input: {
         amount?: bigint;
         frequency?: DcaFrequency;
         budgetRemaining?: bigint;
         maxSlippageBps?: number;
         status?: 'active' | 'paused';
         spendingAuth?: string;
      }
   ) {
      const existing = await prisma.dcaPlan.findUnique({ where: { id } });
      if (!existing) throw new DcaPlanNotFoundError(id);
      if (existing.wallet !== wallet) throw new DcaPlanForbiddenError();

      const updated = await prisma.dcaPlan.update({
         where: { id },
         data: {
            ...(input.amount !== undefined ? { amount: input.amount } : {}),
            ...(input.frequency !== undefined ? { frequency: input.frequency } : {}),
            ...(input.budgetRemaining !== undefined
               ? { budgetRemaining: input.budgetRemaining }
               : {}),
            ...(input.maxSlippageBps !== undefined
               ? { maxSlippageBps: input.maxSlippageBps }
               : {}),
            ...(input.spendingAuth !== undefined
               ? { spendingAuth: input.spendingAuth }
               : {}),
            ...(input.status !== undefined
               ? {
                    status: input.status,
                    ...(input.status === 'active'
                       ? { consecutiveFailures: 0 }
                       : {}),
                 }
               : {}),
         },
      });

      return serializePlan(updated);
   }

   async deletePlan(wallet: string, id: string): Promise<void> {
      const existing = await prisma.dcaPlan.findUnique({ where: { id } });
      if (!existing) throw new DcaPlanNotFoundError(id);
      if (existing.wallet !== wallet) throw new DcaPlanForbiddenError();

      await prisma.dcaPlan.delete({ where: { id } });
   }

   async listPlanRuns(wallet: string, planId: string, limit = 50) {
      const plan = await prisma.dcaPlan.findUnique({ where: { id: planId } });
      if (!plan) throw new DcaPlanNotFoundError(planId);
      if (plan.wallet !== wallet) throw new DcaPlanForbiddenError();

      const runs = await prisma.dcaRun.findMany({
         where: { planId },
         orderBy: { scheduledFor: 'desc' },
         take: Math.min(Math.max(limit, 1), 100),
      });

      return runs.map(r => ({
         id: r.id,
         planId: r.planId,
         scheduledFor: r.scheduledFor.toISOString(),
         status: r.status,
         reason: r.reason,
         amountSpent: r.amountSpent !== null ? r.amountSpent.toString() : null,
         txHash: r.txHash,
         createdAt: r.createdAt.toISOString(),
      }));
   }
}

export const dcaService = new DcaService();
