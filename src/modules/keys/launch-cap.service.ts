import { prisma } from '../../utils/prisma.utils';

export interface LaunchCapConfigInput {
   keyId: string;
   startLedger: number;
   endLedger: number;
   startCap: bigint;
   endCap: bigint;
   exemptWallets?: string[];
}

export interface LaunchCapSnapshot {
   startLedger: number;
   endLedger: number;
   startCap: bigint;
   endCap: bigint;
}

/**
 * Linear interpolation of the per-wallet cap from startCap (at startLedger)
 * to endCap (at endLedger). Before the window the start cap applies; at
 * the end ledger the end cap applies exactly.
 */
export function capAt(config: LaunchCapSnapshot, ledger: number): bigint {
   if (ledger <= config.startLedger) return config.startCap;
   if (ledger >= config.endLedger) return config.endCap;
   const span = config.endLedger - config.startLedger;
   if (span <= 0) return config.endCap;
   const elapsed = BigInt(ledger - config.startLedger);
   const delta = config.endCap - config.startCap;
   return config.startCap + (delta * elapsed) / BigInt(span);
}

export class LaunchWindowNotActiveError extends Error {
   constructor(message = 'Launch window is not active for this key') {
      super(message);
      this.name = 'LaunchWindowNotActiveError';
   }
}

export async function upsertLaunchCapConfig(input: LaunchCapConfigInput) {
   return prisma.launchCapConfig.upsert({
      where: { keyId: input.keyId },
      create: {
         keyId: input.keyId,
         startLedger: input.startLedger,
         endLedger: input.endLedger,
         startCap: input.startCap.toString(),
         endCap: input.endCap.toString(),
         exemptWallets: input.exemptWallets ?? [],
      },
      update: {
         startLedger: input.startLedger,
         endLedger: input.endLedger,
         startCap: input.startCap.toString(),
         endCap: input.endCap.toString(),
         exemptWallets: input.exemptWallets ?? [],
      },
   });
}

export async function recordLaunchPurchase(input: {
   id: string;
   keyId: string;
   wallet: string;
   amount: bigint;
   ledger: number;
}) {
   // Idempotent on event id to tolerate re-ingestion.
   return prisma.launchPurchase.upsert({
      where: { id: input.id },
      create: {
         id: input.id,
         keyId: input.keyId,
         wallet: input.wallet,
         amount: input.amount.toString(),
         ledger: input.ledger,
      },
      update: {},
   });
}

export interface LaunchCapStatus {
   keyId: string;
   wallet: string;
   windowActive: boolean;
   exempt: boolean;
   cap: string | null;
   purchased: string;
   remaining: string | null;
   nextIncreaseLedger: number | null;
   startLedger: number | null;
   endLedger: number | null;
}

/**
 * Compute the per-wallet cap status for the current ledger.
 * Returns windowActive=false with all caps nulled once the window has ended.
 */
export async function getLaunchCapStatus(
   keyId: string,
   wallet: string,
   ledger: number
): Promise<LaunchCapStatus> {
   const config = await prisma.launchCapConfig.findUnique({ where: { keyId } });
   if (!config) {
      return {
         keyId,
         wallet,
         windowActive: false,
         exempt: false,
         cap: null,
         purchased: '0',
         remaining: null,
         nextIncreaseLedger: null,
         startLedger: null,
         endLedger: null,
      };
   }
   const windowActive = ledger <= config.endLedger;
   const exempt = config.exemptWallets.includes(wallet);
   const purchases = await prisma.launchPurchase.findMany({
      where: {
         keyId,
         wallet,
         ledger: { gte: config.startLedger, lte: config.endLedger },
      },
   });
   const purchased = purchases.reduce((acc, p) => acc + BigInt(p.amount), 0n);

   if (!windowActive) {
      return {
         keyId,
         wallet,
         windowActive: false,
         exempt,
         cap: null,
         purchased: purchased.toString(),
         remaining: null,
         nextIncreaseLedger: null,
         startLedger: config.startLedger,
         endLedger: config.endLedger,
      };
   }

   if (exempt) {
      return {
         keyId,
         wallet,
         windowActive: true,
         exempt: true,
         cap: null,
         purchased: purchased.toString(),
         remaining: null,
         nextIncreaseLedger: null,
         startLedger: config.startLedger,
         endLedger: config.endLedger,
      };
   }

   const snapshot: LaunchCapSnapshot = {
      startLedger: config.startLedger,
      endLedger: config.endLedger,
      startCap: BigInt(config.startCap),
      endCap: BigInt(config.endCap),
   };
   const cap = capAt(snapshot, ledger);
   const remaining = cap > purchased ? cap - purchased : 0n;
   const nextIncreaseLedger =
      ledger < config.endLedger ? Math.min(ledger + 1, config.endLedger) : null;

   return {
      keyId,
      wallet,
      windowActive: true,
      exempt: false,
      cap: cap.toString(),
      purchased: purchased.toString(),
      remaining: remaining.toString(),
      nextIncreaseLedger,
      startLedger: config.startLedger,
      endLedger: config.endLedger,
   };
}

/**
 * Sample the cap ramp between startLedger and endLedger at `points` evenly
 * spaced ledgers (inclusive). Useful for charting the cap curve in the UI.
 */
export async function getLaunchCapRamp(keyId: string, points: number) {
   const config = await prisma.launchCapConfig.findUnique({ where: { keyId } });
   if (!config) return [] as Array<{ ledger: number; cap: string }>;
   const snapshot: LaunchCapSnapshot = {
      startLedger: config.startLedger,
      endLedger: config.endLedger,
      startCap: BigInt(config.startCap),
      endCap: BigInt(config.endCap),
   };
   const samples: Array<{ ledger: number; cap: string }> = [];
   if (points <= 1) {
      samples.push({ ledger: config.startLedger, cap: snapshot.startCap.toString() });
      return samples;
   }
   const span = Math.max(1, config.endLedger - config.startLedger);
   for (let i = 0; i < points; i++) {
      const sampleLedger = Math.round(config.startLedger + (span * i) / (points - 1));
      samples.push({ ledger: sampleLedger, cap: capAt(snapshot, sampleLedger).toString() });
   }
   return samples;
}
