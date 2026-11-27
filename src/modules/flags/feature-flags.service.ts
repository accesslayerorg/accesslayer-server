import { createHash } from 'crypto';
import { envConfig } from '../../config';
import { prisma } from '../../utils/prisma.utils';

export const FEATURE_FLAG_NAME_PATTERN = /^[a-z0-9_.-]{3,64}$/;

export interface FlagContext {
   wallet?: string;
   environment?: string;
}

export interface FeatureFlagDefinition {
   name: string;
   enabled: boolean;
   rules: unknown;
   updatedBy: string;
   updatedAt: Date;
}

interface CachedDefinitions {
   expiresAt: number;
   values: FeatureFlagDefinition[];
}

type FlagDatabase = {
   featureFlag: {
      findMany(args?: unknown): Promise<FeatureFlagDefinition[]>;
      findUnique(args: unknown): Promise<FeatureFlagDefinition | null>;
      upsert(args: unknown): Promise<FeatureFlagDefinition>;
   };
};

export class FlagService {
   private cache: CachedDefinitions | null = null;
   private readonly ttlMs = 30_000;

   constructor(private readonly db: FlagDatabase = prisma as unknown as FlagDatabase) {}

   isValidName(name: string): boolean {
      return FEATURE_FLAG_NAME_PATTERN.test(name);
   }

   invalidate(): void {
      this.cache = null;
   }

   async listDefinitions(): Promise<FeatureFlagDefinition[]> {
      if (this.cache && this.cache.expiresAt > Date.now()) {
         return this.cache.values;
      }

      const values = await (this.db.featureFlag.findMany as any)({
         orderBy: { name: 'asc' },
      });
      this.cache = { values, expiresAt: Date.now() + this.ttlMs };
      return values;
   }

   async evaluate(name: string, context: FlagContext = {}): Promise<boolean> {
      if (!this.isValidName(name)) {
         throw new Error('Invalid feature flag name');
      }
      const definitions = await this.listDefinitions();
      const flag = definitions.find(item => item.name === name);
      if (!flag) return false;
      return this.evaluateDefinition(flag, context);
   }

   evaluateDefinition(
      flag: Pick<FeatureFlagDefinition, 'enabled' | 'rules' | 'name'>,
      context: FlagContext = {}
   ): boolean {
      if (!flag.enabled) return false;

      const wallet = context.wallet?.trim();
      const environment = (context.environment || envConfig.MODE).toLowerCase();
      const rules = flag.rules as any;
      let hasAllowlistRule = false;
      let allowlistMatched = false;
      let hasPercentageRule = false;

      const ruleEntries = Array.isArray(rules)
         ? rules
         : [rules && typeof rules === 'object' ? rules : {}];

      for (const rule of ruleEntries) {
         if (!rule || typeof rule !== 'object') continue;
         const type = typeof rule.type === 'string' ? rule.type.toLowerCase() : undefined;

         if (type === 'allowlist' || type === 'wallet_allowlist' || type === 'walletallowlist') {
            hasAllowlistRule = true;
            const allowlist = this.toStringArray(
               rule.wallets ?? rule.allowlist ?? rule.walletAllowlist
            );
            if (wallet && allowlist.some(item => item.toLowerCase() === wallet.toLowerCase())) {
               allowlistMatched = true;
               return true;
            }
         } else if (type === 'environment') {
            const allowed = this.toStringArray(
               rule.environments ?? rule.environment ?? rule.values
            ).map(item => item.toLowerCase());
            if (allowed.length > 0 && !allowed.includes(environment)) return false;
         } else if (type === 'percentage' || type === 'rollout') {
            hasPercentageRule = true;
            const raw = rule.percentage ?? rule.percent ?? rule.rollout;
            if (typeof raw === 'number' && raw >= 100) continue;
            if (typeof raw === 'number' && raw <= 0) return false;
            if (typeof raw === 'number' && (!wallet || !this.isInPercentage(flag.name, wallet, raw))) {
               return false;
            }
         } else {
            // Object-shaped rules (the common admin/API representation).
            const walletAllowlist = this.toStringArray(
               rule.walletAllowlist ?? rule.allowlist ?? rule.wallets
            );
            if (walletAllowlist.length > 0) {
               hasAllowlistRule = true;
            }
            if (
               wallet &&
               walletAllowlist.some(item => item.toLowerCase() === wallet.toLowerCase())
            ) {
               allowlistMatched = true;
               return true;
            }

            const environments = this.toStringArray(
               rule.environments ?? rule.environment
            ).map(item => item.toLowerCase());
            if (environments.length > 0 && !environments.includes(environment)) {
               return false;
            }

            const percentageRaw =
               typeof rule.percentage === 'number'
                  ? rule.percentage
                  : typeof rule.percentageRollout === 'number'
                    ? rule.percentageRollout
                    : typeof rule.percent === 'number'
                      ? rule.percent
                      : typeof rule.rollout === 'number'
                        ? rule.rollout
                        : rule.percentage && typeof rule.percentage === 'object'
                          ? rule.percentage.value
                          : undefined;
            if (typeof percentageRaw === 'number') {
               hasPercentageRule = true;
               if (percentageRaw <= 0) return false;
               if (percentageRaw < 100 && (!wallet || !this.isInPercentage(flag.name, wallet, percentageRaw))) {
                  return false;
               }
            }
         }
      }

      if (hasAllowlistRule && !allowlistMatched && !hasPercentageRule) {
         return false;
      }
      return true;
   }

   private toStringArray(value: unknown): string[] {
      if (typeof value === 'string') return [value];
      if (!Array.isArray(value)) return [];
      return value.filter((item): item is string => typeof item === 'string');
   }

   private isInPercentage(name: string, wallet: string, percentage: number): boolean {
      const bucket = parseInt(
         createHash('sha256').update(`${name}:${wallet.toLowerCase()}`).digest('hex').slice(0, 8),
         16
      ) % 10_000;
      return bucket < Math.max(0, Math.min(100, percentage)) * 100;
   }

   async update(name: string, enabled: boolean, rules: unknown, updatedBy: string) {
      if (!this.isValidName(name)) {
         throw new Error('Invalid feature flag name');
      }
      const record = await (this.db.featureFlag.upsert as any)({
         where: { name },
         update: { enabled, rules: rules as any, updatedBy },
         create: { name, enabled, rules: rules as any, updatedBy },
      });
      this.invalidate();
      return record;
   }
}

export const flagService = new FlagService();
