// src/modules/portfolio/portfolio-health-score.service.ts
// Portfolio health score for a wallet (#1178). The score is computed on chain
// by the health-score contract; this service reads it with a read-only
// simulation and caches the result for five minutes. HealthScoreUpdated events
// clear the cache for the affected wallet.
//
// A wallet with no portfolio returns score: null and factors: null.

import {
   Account,
   Address,
   Contract,
   Networks,
   TransactionBuilder,
   scValToNative,
   xdr,
} from '@stellar/stellar-base';
import { envConfig } from '../../config';
import { defaultSorobanTransport } from '../../clients/soroban.client';
import {
   cacheGetJson,
   cacheInvalidate,
   cacheSetJson,
} from '../../utils/redis.utils';

export const HEALTH_SCORE_CACHE_TTL_SECONDS = 300;
const U32_MAX = 4_294_967_295;

export class HealthScoreUnavailableError extends Error {
   constructor(message = 'Portfolio health score is unavailable') {
      super(message);
      this.name = 'HealthScoreUnavailableError';
   }
}

export interface HealthScoreFactors {
   concentration_score: number;
   maturity_distribution_score: number;
   issuer_diversity_score: number;
   default_exposure_score: number;
}

export interface InvestorHealthScore {
   wallet: string;
   score: number | null;
   factors: HealthScoreFactors | null;
   computed_at: string;
}

export function healthScoreCacheKey(wallet: string): string {
   return `investors:health-score:${wallet}`;
}

export async function invalidateHealthScoreCache(wallet: string): Promise<void> {
   await cacheInvalidate(healthScoreCacheKey(wallet));
}

function toScore(value: unknown): number | null {
   const numeric = typeof value === 'bigint' ? Number(value) : value;
   return typeof numeric === 'number' &&
      Number.isSafeInteger(numeric) &&
      numeric >= 0 &&
      numeric <= U32_MAX
      ? numeric
      : null;
}

/**
 * Decodes the contract's return value. null or undefined means the wallet has
 * no portfolio. Any other shape must carry the composite score and all four
 * factor scores, or the read is treated as unavailable.
 */
export function parseHealthScoreResult(
   value: unknown
): Pick<InvestorHealthScore, 'score' | 'factors'> {
   if (value === null || value === undefined) {
      return { score: null, factors: null };
   }

   const row = value as Record<string, unknown>;
   const score = toScore(row.score);
   const factors = {
      concentration_score: toScore(row.concentration_score),
      maturity_distribution_score: toScore(row.maturity_distribution_score),
      issuer_diversity_score: toScore(row.issuer_diversity_score),
      default_exposure_score: toScore(row.default_exposure_score),
   };
   if (
      score === null ||
      factors.concentration_score === null ||
      factors.maturity_distribution_score === null ||
      factors.issuer_diversity_score === null ||
      factors.default_exposure_score === null
   ) {
      throw new HealthScoreUnavailableError('Invalid health score response');
   }
   return {
      score,
      factors: factors as HealthScoreFactors,
   };
}

/** Read-only simulation of get_health_score. Never signs or submits. */
async function simulateHealthScore(wallet: string): Promise<unknown> {
   const contractId = envConfig.PORTFOLIO_HEALTH_CONTRACT_ID;
   if (!contractId) {
      throw new HealthScoreUnavailableError(
         'Health score contract is not configured'
      );
   }

   const networkPassphrase =
      envConfig.STELLAR_NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
   const transaction = new TransactionBuilder(new Account(wallet, '0'), {
      fee: '100',
      networkPassphrase,
   })
      .addOperation(
         new Contract(contractId).call(
            'get_health_score',
            new Address(wallet).toScVal()
         )
      )
      .setTimeout(300)
      .build()
      .toXDR();

   try {
      const envelope = (await defaultSorobanTransport(
         envConfig.STELLAR_SOROBAN_RPC_URL,
         {
            jsonrpc: '2.0',
            id: 'health-score',
            method: 'simulateTransaction',
            params: { transaction },
         }
      )) as {
         error?: unknown;
         result?: {
            error?: unknown;
            results?: Array<{ xdr?: string; retval?: string }>;
         };
      };
      const first = envelope.result?.results?.[0];
      const returnValue = first?.xdr ?? first?.retval;
      if (envelope.error || envelope.result?.error || !returnValue) {
         throw new HealthScoreUnavailableError('Simulation returned no result');
      }
      return scValToNative(xdr.ScVal.fromXDR(returnValue, 'base64'));
   } catch (error) {
      if (error instanceof HealthScoreUnavailableError) {
         throw error;
      }
      throw new HealthScoreUnavailableError('Unable to read get_health_score');
   }
}

export async function getInvestorHealthScore(
   wallet: string
): Promise<InvestorHealthScore> {
   const cacheKey = healthScoreCacheKey(wallet);
   const cached = await cacheGetJson<InvestorHealthScore>(cacheKey);
   if (cached) return cached;

   const parsed = parseHealthScoreResult(await simulateHealthScore(wallet));
   const result: InvestorHealthScore = {
      wallet,
      ...parsed,
      computed_at: new Date().toISOString(),
   };
   await cacheSetJson(cacheKey, result, HEALTH_SCORE_CACHE_TTL_SECONDS);
   return result;
}
