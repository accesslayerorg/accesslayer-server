import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { envConfig } from '../../config';
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheInvalidate, cacheSetJson } from '../../utils/redis.utils';

export interface ConcentrationThresholds {
   medium: number;
   high: number;
}

export interface ConcentrationStatistics {
   holderCount: number;
   top1Share: number;
   top5Share: number;
   top10Share: number;
   giniCoefficient: number;
   concentrationLevel: 'low' | 'medium' | 'high';
}

const settingsSchema = z.object({
   CONCENTRATION_MEDIUM_THRESHOLD: z.coerce.number().min(0).max(1).default(0.25),
   CONCENTRATION_HIGH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
   CONCENTRATION_EXCLUDED_ADDRESSES: z.string().default('').refine(value =>
      value.split(',').map(address => address.trim()).filter(Boolean)
         .every(address => /^[GC][A-Z2-7]{55}$/.test(address)),
      'Excluded concentration addresses must be Stellar accounts or contracts'),
}).refine(
   value => value.CONCENTRATION_MEDIUM_THRESHOLD < value.CONCENTRATION_HIGH_THRESHOLD,
   'Concentration medium threshold must be below the high threshold'
);

const settings = settingsSchema.parse(envConfig);
const thresholds: ConcentrationThresholds = {
   medium: settings.CONCENTRATION_MEDIUM_THRESHOLD,
   high: settings.CONCENTRATION_HIGH_THRESHOLD,
};

export class ConcentrationKeyNotFoundError extends Error {
   constructor() {
      super('Key not found');
      this.name = 'ConcentrationKeyNotFoundError';
   }
}

export const concentrationCacheKey = (keyId: string, includeContracts: boolean): string =>
   `key:concentration:${keyId}:${includeContracts ? 'all' : 'wallets'}`;

const RATIO_SCALE = 10n ** 18n;

/** Convert only a final bounded ratio to a JSON number; balances stay exact. */
function ratio(numerator: bigint, denominator: bigint): number {
   return denominator === 0n ? 0 : Number(numerator * RATIO_SCALE / denominator) / 1e18;
}

/** Shares are fractions of the included positive balances, in [0, 1]. */
export function calculateConcentration(
   amounts: (Prisma.Decimal | string | number)[],
   levels: ConcentrationThresholds = thresholds
): ConcentrationStatistics {
   const values = amounts.map(value => new Prisma.Decimal(value).toFixed());
   if (values.some(value => !/^\d+(\.\d+)?$/.test(value))) {
      throw new Error('Holder balances must be finite and non-negative');
   }
   const scale = values.reduce((max, value) =>
      Math.max(max, value.split('.')[1]?.length ?? 0), 0);
   const balances = values.map(value => {
      const [whole, fractional = ''] = value.split('.');
      return BigInt(whole + fractional.padEnd(scale, '0'));
   }).filter(value => value > 0n).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
   const count = balances.length;
   const total = balances.reduce((sum, value) => sum + value, 0n);
   const topShare = (n: number) => ratio(
      balances.slice(-n).reduce((sum, value) => sum + value, 0n), total);
   const weighted = balances.reduce(
      (sum, value, index) => sum + BigInt(2 * index - count + 1) * value, 0n);
   const top1Share = topShare(1);
   return {
      holderCount: count,
      top1Share,
      top5Share: topShare(5),
      top10Share: topShare(10),
      giniCoefficient: ratio(weighted, BigInt(count) * total),
      concentrationLevel: count === 0 ? 'low'
         : top1Share >= levels.high ? 'high'
         : top1Share >= levels.medium ? 'medium' : 'low',
   };
}

async function excludedAddresses(): Promise<Set<string>> {
   const [registered, deployed] = await Promise.all([
      prisma.registeredKey.findMany({ select: { keyAddress: true } }),
      prisma.factoryDeployedKey.findMany({ select: { contractAddress: true } }),
   ]);
   return new Set([
      ...registered.map(row => row.keyAddress),
      ...deployed.map(row => row.contractAddress),
      ...settings.CONCENTRATION_EXCLUDED_ADDRESSES.split(',').map(value => value.trim()).filter(Boolean),
   ]);
}

export class ConcentrationService {
   static async compute(keyId: string, includeContracts = false) {
      const creator = await prisma.creatorProfile.findFirst({
         where: { OR: [{ id: keyId }, { handle: keyId }] },
         select: { id: true },
      });
      if (!creator) throw new ConcentrationKeyNotFoundError();
      const cacheKey = concentrationCacheKey(creator.id, includeContracts);
      const cached = await cacheGetJson<ConcentrationStatistics & { keyId: string }>(cacheKey);
      if (cached !== null) return cached;
      const [rows, excluded] = await Promise.all([
         prisma.keyOwnership.findMany({
            where: { creatorId: creator.id, balance: { gt: 0 } },
            select: { ownerAddress: true, balance: true },
         }),
         includeContracts ? Promise.resolve(new Set<string>()) : excludedAddresses(),
      ]);
      const amounts = rows.filter(row => includeContracts ||
         (!/^C[A-Z2-7]{55}$/.test(row.ownerAddress) && !excluded.has(row.ownerAddress)))
         .map(row => row.balance);
      const result = { keyId: creator.id, ...calculateConcentration(amounts) };
      await cacheSetJson(cacheKey, result, 300);
      return result;
   }
}

/** Call after a committed balance change; even small changes may cross a threshold. */
export async function onConcentrationBalanceChanged(keyId: string): Promise<void> {
   await cacheInvalidate(concentrationCacheKey(keyId, false));
   await cacheInvalidate(concentrationCacheKey(keyId, true));
}
