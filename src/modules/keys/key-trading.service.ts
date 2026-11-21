import { prisma } from '../../utils/prisma.utils';

export class TradingPausedError extends Error {
   constructor() {
      super('Trading paused for this key');
   }
}

export async function assertTradingActive(creatorId: string): Promise<void> {
   const creator = await prisma.creatorProfile.findUnique({
      where: { id: creatorId },
      select: { tradingPaused: true },
   });
   if (creator?.tradingPaused) {
      throw new TradingPausedError();
   }
}