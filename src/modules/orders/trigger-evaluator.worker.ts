// src/modules/orders/trigger-evaluator.worker.ts
//
// TriggerEvaluatorWorker — scans active OCO trigger groups every 5 seconds
// against the latest price and fires legs atomically. The worker is
// stateless; concurrency safety comes from the WHERE-guard inside
// `fireLegAtomic`, so two workers racing on the same leg cannot double-fire.
//
// Caller supplies: a priceLookup(keyId) returning the latest price, an
// optional onFire() hook for placing the resulting sell order, and an
// optional interval override (default 5000 ms).

import { prisma } from '../../utils/prisma.utils';
import {
   fireLegAtomic,
   LegEvaluation,
   shouldLegFire,
} from './trigger-group.service';

export interface TriggerEvaluatorOptions {
   priceLookup: (keyId: string) => Promise<bigint | null>;
   onFire?: (ctx: { groupId: string; legId: string; type: string; price: bigint }) => Promise<void>;
   intervalMs?: number;
   now?: () => Date;
}

export class TriggerEvaluatorWorker {
   private timer: NodeJS.Timeout | null = null;
   constructor(private readonly opts: TriggerEvaluatorOptions) {}

   start() {
      if (this.timer) return;
      const interval = this.opts.intervalMs ?? 5000;
      this.timer = setInterval(() => this.tick().catch(() => undefined), interval);
   }

   stop() {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
   }

   /**
    * Evaluate every armed leg exactly once. Public so tests can drive
    * ticks deterministically without wall-clock timers.
    */
   async tick(): Promise<void> {
      const armed = await prisma.triggerLeg.findMany({
         where: { status: 'armed', group: { status: 'active' } },
         include: { group: { select: { id: true, keyId: true } } },
      });
      // Group legs by key so we only fetch each price once.
      const byKey = new Map<string, typeof armed>();
      for (const leg of armed) {
         const arr = byKey.get(leg.group.keyId) ?? [];
         arr.push(leg);
         byKey.set(leg.group.keyId, arr);
      }
      for (const [keyId, legs] of byKey.entries()) {
         const price = await this.opts.priceLookup(keyId);
         if (price === null) continue;
         for (const leg of legs) {
            const evalInput: LegEvaluation = {
               legId: leg.id,
               groupId: leg.groupId,
               type: leg.type as LegEvaluation['type'],
               triggerPrice: BigInt(leg.triggerPrice),
            };
            if (!shouldLegFire(evalInput, price)) continue;
            const result = await fireLegAtomic(
               leg.groupId,
               leg.id,
               this.opts.now ? this.opts.now() : new Date(),
            );
            if (result.fired && this.opts.onFire) {
               await this.opts.onFire({
                  groupId: leg.groupId,
                  legId: leg.id,
                  type: leg.type,
                  price,
               });
            }
         }
      }
   }
}
