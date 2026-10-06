import { prisma } from '../../utils/prisma.utils';
import { getTierForSupply } from '../keys/key-milestones.service';

const MAX_ATTEMPTS = 3;

function delay(milliseconds: number): Promise<void> {
   return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export async function persistCirculatingSupply(creatorId: string): Promise<number> {
   let lastError: unknown;
   for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
         let supply = 0;
         await prisma.$transaction(async (transaction) => {
            const activities = await transaction.activity.findMany({
               where: { creatorId, type: { in: ['KEY_BOUGHT', 'KEY_SOLD'] } },
               select: { type: true, payload: true },
            });

            supply = activities.reduce((total: number, activity: { type: string; payload: any }) => {
               const amount = Number((activity.payload as { amount?: number }).amount ?? 0);
               return activity.type === 'KEY_BOUGHT' ? total + amount : total - amount;
            }, 0);

            const oldCreator = await transaction.creatorProfile.findUnique({
               where: { id: creatorId },
               select: { currentMilestone: true },
            });

            const newMilestone = getTierForSupply(supply);
            const oldMilestone = oldCreator?.currentMilestone ?? 0;

            await transaction.creatorProfile.update({
               where: { id: creatorId },
               data: { circulatingSupply: supply, currentMilestone: newMilestone },
            });

            if (newMilestone !== oldMilestone) {
               const direction = newMilestone > oldMilestone ? 'up' : 'down';
               await transaction.activity.create({
                  data: {
                     type: 'MILESTONE_CROSSED' as any,
                     actor: 'system',
                     creatorId,
                     payload: {
                        keyId: creatorId,
                        milestoneTier: newMilestone,
                        oldMilestone,
                        newMilestone,
                        supply,
                        direction,
                     },
                  },
               });
            }
         });
         return supply;
      } catch (error) {
         lastError = error;
         if (attempt < MAX_ATTEMPTS - 1) {
            await delay(100 * 2 ** attempt);
         }
      }
   }
   throw lastError;
	
}
