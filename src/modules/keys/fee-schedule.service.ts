import { prisma } from '../../utils/prisma.utils';

export interface FeeScheduleInput {
   keyId: string;
   startBps: number;
   floorBps: number;
   decayLedgers: number;
   startLedger: number;
}

export function feeAt(schedule: FeeScheduleInput, ledger: number): number {
   if (schedule.decayLedgers <= 0 || ledger >= schedule.startLedger + schedule.decayLedgers) return schedule.floorBps;
   if (ledger <= schedule.startLedger) return schedule.startBps;
   const elapsed = ledger - schedule.startLedger;
   return Math.max(schedule.floorBps, Math.round(schedule.startBps - ((schedule.startBps - schedule.floorBps) * elapsed) / schedule.decayLedgers));
}

export async function getFeeSchedule(keyId: string, ledger: number) {
   const schedule = await prisma.feeSchedule.findUnique({ where: { keyId } });
   if (!schedule) return { keyId, startBps: 0, floorBps: 0, decayLedgers: 0, startLedger: ledger, locked: false, currentBps: 0, nextChangeLedger: null };
   return {
      ...schedule,
      currentBps: feeAt(schedule, ledger),
      nextChangeLedger: ledger < schedule.startLedger + schedule.decayLedgers ? ledger + 1 : null,
   };
}

export async function getFeeCurve(keyId: string, ledger: number, points: number) {
   const schedule = await prisma.feeSchedule.findUnique({ where: { keyId } });
   if (!schedule) return Array.from({ length: points }, (_, i) => ({ ledger: ledger + i, feeBps: 0 }));
   const end = schedule.startLedger + schedule.decayLedgers;
   return Array.from({ length: points }, (_, i) => {
      const sampleLedger = points === 1 ? ledger : Math.round(ledger + ((Math.max(ledger, end) - ledger) * i) / (points - 1));
      return { ledger: sampleLedger, feeBps: feeAt(schedule, sampleLedger) };
   });
}

export async function upsertFeeSchedule(input: FeeScheduleInput) {
   return prisma.feeSchedule.upsert({ where: { keyId: input.keyId }, create: input, update: input });
}

export async function lockFeeSchedule(keyId: string) {
   await prisma.feeSchedule.updateMany({ where: { keyId, locked: false }, data: { locked: true } });
}
