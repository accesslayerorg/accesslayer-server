import { prisma } from '../../utils/prisma.utils';

export class InvalidTriggerError extends Error {
   constructor(message: string) {
      super(message);
      this.name = 'InvalidTriggerError';
   }
}

export interface CreateTriggerInput {
   wallet: string;
   keyId: string;
   totalAmount: bigint;
   currentPrice: bigint;
   takeProfitPrice: bigint;
   stopLossPrice: bigint;
   walletBalance: bigint;
}

/**
 * Validate a candidate trigger group against the current price and the
 * wallet's holding balance. Pure — the service wrapper handles persistence.
 *
 * - take-profit price must be above the current price
 * - stop-loss price must be below the current price
 * - totalAmount must not exceed the wallet's current balance
 */
export function validateTrigger(input: CreateTriggerInput): void {
   if (input.totalAmount <= 0n) {
      throw new InvalidTriggerError('totalAmount must be positive');
   }
   if (input.totalAmount > input.walletBalance) {
      throw new InvalidTriggerError('totalAmount exceeds wallet balance');
   }
   if (input.takeProfitPrice <= input.currentPrice) {
      throw new InvalidTriggerError('takeProfitPrice must be above currentPrice');
   }
   if (input.stopLossPrice >= input.currentPrice) {
      throw new InvalidTriggerError('stopLossPrice must be below currentPrice');
   }
}

export async function createTriggerGroup(
   input: CreateTriggerInput & { id: string; takeProfitLegId: string; stopLossLegId: string },
) {
   validateTrigger(input);
   return prisma.triggerGroup.create({
      data: {
         id: input.id,
         wallet: input.wallet,
         keyId: input.keyId,
         totalAmount: input.totalAmount.toString(),
         status: 'active',
         legs: {
            create: [
               {
                  id: input.takeProfitLegId,
                  type: 'take_profit',
                  triggerPrice: input.takeProfitPrice.toString(),
                  status: 'armed',
               },
               {
                  id: input.stopLossLegId,
                  type: 'stop_loss',
                  triggerPrice: input.stopLossPrice.toString(),
                  status: 'armed',
               },
            ],
         },
      },
      include: { legs: true },
   });
}

export async function cancelTriggerGroup(groupId: string) {
   await prisma.$transaction([
      prisma.triggerLeg.updateMany({
         where: { groupId, status: 'armed' },
         data: { status: 'cancelled' },
      }),
      prisma.triggerGroup.update({
         where: { id: groupId },
         data: { status: 'cancelled' },
      }),
   ]);
}

export interface LegEvaluation {
   legId: string;
   groupId: string;
   type: 'take_profit' | 'stop_loss';
   triggerPrice: bigint;
}

/**
 * Decide whether a leg should fire against the current price.
 *
 * take-profit fires when price >= trigger; stop-loss when price <= trigger.
 */
export function shouldLegFire(leg: LegEvaluation, currentPrice: bigint): boolean {
   if (leg.type === 'take_profit') return currentPrice >= leg.triggerPrice;
   return currentPrice <= leg.triggerPrice;
}

/**
 * Atomic fire for a leg: marks the winning leg fired and the sibling
 * cancelled inside a single transaction, with a WHERE guard that another
 * worker instance cannot satisfy once the first has committed. If the
 * guarded update affects zero rows the caller is responsible for skipping
 * the matching sell-order creation — this prevents the leg from firing
 * twice when two workers are racing.
 */
export async function fireLegAtomic(
   groupId: string,
   legId: string,
   firedAt: Date,
): Promise<{ fired: boolean }> {
   return prisma.$transaction(async (tx: any) => {
      const updated = await tx.triggerLeg.updateMany({
         where: { id: legId, groupId, status: 'armed' },
         data: { status: 'fired', firedAt },
      });
      if (updated.count !== 1) return { fired: false };
      // Cancel the sibling leg(s) atomically.
      await tx.triggerLeg.updateMany({
         where: { groupId, status: 'armed', NOT: { id: legId } },
         data: { status: 'cancelled' },
      });
      await tx.triggerGroup.update({
         where: { id: groupId },
         data: { status: 'fired' },
      });
      return { fired: true };
   });
}

/**
 * Cancel all legs when the holding balance drops to zero — triggers that
 * can no longer sell anything become dead weight.
 */
export async function cancelOnEmptyBalance(wallet: string, keyId: string) {
   const groups = await prisma.triggerGroup.findMany({
      where: { wallet, keyId, status: 'active' },
      select: { id: true },
   });
   for (const g of groups) await cancelTriggerGroup(g.id);
}

export async function listActiveTriggers(wallet?: string) {
   return prisma.triggerGroup.findMany({
      where: { status: 'active', ...(wallet ? { wallet } : {}) },
      orderBy: { createdAt: 'desc' },
      include: { legs: true },
   });
}
