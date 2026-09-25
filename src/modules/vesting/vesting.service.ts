// src/modules/vesting/vesting.service.ts
import { prisma } from '../../utils/prisma.utils';

export class VestingNotFoundError extends Error {
   constructor(keyId: string, wallet: string) {
      super(`Vesting schedule not found for key ${keyId} and wallet ${wallet}`);
      this.name = 'VestingNotFoundError';
   }
}

export interface VestingSchedule {
   keyId: string;
   wallet: string;
   totalKeys: string;
   startLedger: number;
   endLedger: number;
   claimedKeys: string;
   vestedAmount: string;
   claimableAmount: string;
}

export async function getVestingSchedule(
   keyId: string,
   wallet: string,
   currentLedger: number
): Promise<VestingSchedule> {
   const schedule = await prisma.vestingSchedule.findUnique({
      where: { keyId_wallet: { keyId, wallet } },
   });

   if (!schedule) {
      throw new VestingNotFoundError(keyId, wallet);
   }

   const total = BigInt(schedule.totalKeys.toString());
   const claimed = BigInt(schedule.claimedKeys.toString());
   const start = schedule.startLedger;
   const end = schedule.endLedger;

   let vested = 0n;
   if (currentLedger >= end) {
      vested = total;
   } else if (currentLedger > start) {
      const elapsed = BigInt(currentLedger - start);
      const duration = BigInt(end - start);
      vested = (total * elapsed) / duration;
   }

   const claimable = vested > claimed ? vested - claimed : 0n;

   return {
      keyId: schedule.keyId,
      wallet: schedule.wallet,
      totalKeys: total.toString(),
      startLedger: start,
      endLedger: end,
      claimedKeys: claimed.toString(),
      vestedAmount: vested.toString(),
      claimableAmount: claimable.toString(),
   };
}
