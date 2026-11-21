import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';

const REPUTATION_CACHE_PREFIX = 'reputation:v1:';
const REPUTATION_CACHE_TTL_SECONDS = 300; // 5 minutes

interface ScoreFactors {
   walletAgeDays: number;
   tradeCount: number;
   rejectedReports: number;
}

function calculateScore(factors: ScoreFactors): number {
   const { walletAgeDays, tradeCount, rejectedReports } = factors;

   // Base score: start at 0
   let score = 0;

   // Wallet age factor: older wallets get higher scores
   // Threshold: 30 days to reach full age score
   const ageWeight = Math.min(walletAgeDays / 30, 1);
   score += Math.floor(ageWeight * 30);

   // Trade count factor: more trades = higher reputation
   // Threshold: 100 trades to reach full trade score
   const tradeWeight = Math.min(tradeCount / 100, 1);
   score += Math.floor(tradeWeight * 40);

   // Rejected reports factor: decreases score
   // Each report deducts 5 points, min score is 0
   const reportDeduction = Math.min(rejectedReports * 5, score);
   score -= reportDeduction;

   return Math.max(0, Math.min(100, score));
}

export interface ReputationTier {
   minScore: number;
   maxScore: number;
   budgetPerMinute: number;
   name: string;
}

export const TIERS: ReputationTier[] = [
   { minScore: 0, maxScore: 20, budgetPerMinute: 10, name: 'IRON' },
   { minScore: 21, maxScore: 40, budgetPerMinute: 25, name: 'BRONZE' },
   { minScore: 41, maxScore: 60, budgetPerMinute: 50, name: 'SILVER' },
   { minScore: 61, maxScore: 80, budgetPerMinute: 100, name: 'GOLD' },
   { minScore: 81, maxScore: 100, budgetPerMinute: 200, name: 'PLATINUM' },
];

export function getTier(score: number): ReputationTier {
   return TIERS.find(tier => score >= tier.minScore && score <= tier.maxScore) || TIERS[0];
}

export async function score(address: string): Promise<{ score: number; tier: ReputationTier; factors: ScoreFactors }> {
   // Check cache first
   const cacheKey = `${REPUTATION_CACHE_PREFIX}${address}`;
   const cached = await cacheGetJson<{ score: number; tier: ReputationTier; factors: ScoreFactors }>(cacheKey);
   if (cached) {
      return cached;
   }

   // Calculate wallet age from stellar wallet creation date
   const stellarWallet = await prisma.stellarWallet.findUnique({
      where: { address },
      select: { createdAt: true },
   });

   const walletAgeDays = stellarWallet
      ? Math.max(1, Math.floor((Date.now() - new Date(stellarWallet.createdAt).getTime()) / (1000 * 60 * 60 * 24)))
      : 1;

   // Count trades for this wallet
   const tradeCount = await prisma.trade.count({
      where: {
         OR: [
            { buyer: { address } },
            { creatorId: { equals: address } },
         ],
      } as any,
   });

   // Count rejected reports (using FraudReport model)
   const rejectedReports = await prisma.fraudReport.count({
      where: {
         reporter: address,
         status: 'REJECTED',
      },
   });

   const factors: ScoreFactors = {
      walletAgeDays,
      tradeCount,
      rejectedReports,
   };

   const rawScore = calculateScore(factors);
   const tier = getTier(rawScore);

   const result = {
      score: rawScore,
      tier,
      factors,
   };

   // Cache the result
   await cacheSetJson(cacheKey, result, REPUTATION_CACHE_TTL_SECONDS);

   return result;
}

export function getBudgetForTier(tier: string): number {
   const tierObj = TIERS.find(t => t.name === tier);
   return tierObj ? tierObj.budgetPerMinute : TIERS[0].budgetPerMinute;
}