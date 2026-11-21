import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';

export class CreatorNotFoundError extends Error {
   constructor(wallet: string) {
      super(`Creator not found: ${wallet}`);
      this.name = 'CreatorNotFoundError';
   }
}

export interface ReputationBreakdown {
   keyLaunches: number;
   milestonesReached: number;
   governanceVotes: number;
   deprecations: number;
}

export interface CreatorReputationResponse {
   score: number;
   tier: string;
   breakdown: ReputationBreakdown;
}

export interface ReputationHistoryItem {
   score: number;
   tier: string;
   eventType: string;
   recordedAt: string;
   ledger?: number;
}

export interface ReputationHistoryResponse {
   items: ReputationHistoryItem[];
   hasMore: boolean;
   cursor?: string;
}

// Reputation tier thresholds
const TIER_THRESHOLDS = {
   IRON: 0,
   BRONZE: 100,
   SILVER: 300,
   GOLD: 500,
   PLATINUM: 1000,
};

// Points for each action
const POINTS = {
   KEY_LAUNCH: 50,
   MILESTONE_REACHED: 30,
   GOVERNANCE_VOTE: 5,
   KEY_DEPRECATED: -50,
};

const CACHE_TTL_SECONDS = 60;

/**
 * Calculate reputation tier from score.
 */
function calculateTier(score: number): string {
   if (score >= TIER_THRESHOLDS.PLATINUM) return 'PLATINUM';
   if (score >= TIER_THRESHOLDS.GOLD) return 'GOLD';
   if (score >= TIER_THRESHOLDS.SILVER) return 'SILVER';
   if (score >= TIER_THRESHOLDS.BRONZE) return 'BRONZE';
   return 'IRON';
}

/**
 * Calculate total reputation score from breakdown.
 */
function calculateScore(breakdown: ReputationBreakdown): number {
   return (
      breakdown.keyLaunches * POINTS.KEY_LAUNCH +
      breakdown.milestonesReached * POINTS.MILESTONE_REACHED +
      breakdown.governanceVotes * POINTS.GOVERNANCE_VOTE +
      breakdown.deprecations * POINTS.KEY_DEPRECATED
   );
}

/**
 * Get creator reputation by wallet address.
 * Cached with 60s TTL.
 */
export async function getCreatorReputation(
   wallet: string
): Promise<CreatorReputationResponse> {
   // Resolve wallet to creator ID
   const creator = await prisma.creatorProfile.findFirst({
      where: {
         user: {
            stellarWallet: {
               address: wallet,
            },
         },
      },
      select: { id: true },
   });

   if (!creator) {
      throw new CreatorNotFoundError(wallet);
   }

   // Try cache first
   const cacheKey = `creator-reputation:${creator.id}`;
   const cached = await cacheGetJson<CreatorReputationResponse>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   // Get or create reputation record
   let reputation = await prisma.creatorReputation.findUnique({
      where: { creatorId: creator.id },
      select: {
         currentScore: true,
         tier: true,
         keyLaunches: true,
         milestonesReached: true,
         governanceVotes: true,
         deprecations: true,
      },
   });

   if (!reputation) {
      // Initialize new reputation record
      const newReputation = await prisma.creatorReputation.create({
         data: {
            creatorId: creator.id,
            currentScore: 0,
            tier: 'IRON',
         },
         select: {
            currentScore: true,
            tier: true,
            keyLaunches: true,
            milestonesReached: true,
            governanceVotes: true,
            deprecations: true,
         },
      });
      reputation = newReputation;
   }

   const result: CreatorReputationResponse = {
      score: reputation.currentScore,
      tier: reputation.tier,
      breakdown: {
         keyLaunches: reputation.keyLaunches,
         milestonesReached: reputation.milestonesReached,
         governanceVotes: reputation.governanceVotes,
         deprecations: reputation.deprecations,
      },
   };

   // Cache with 60s TTL
   try {
      await cacheSetJson(cacheKey, result, CACHE_TTL_SECONDS);
   } catch (error) {
      logger.warn({ error, creatorId: creator.id }, 'Failed to cache reputation');
   }

   return result;
}

/**
 * Get reputation history for a creator.
 * Returns score progression in chronological order.
 */
export async function getCreatorReputationHistory(
   wallet: string,
   limit: number = 50,
   cursor?: string
): Promise<ReputationHistoryResponse> {
   // Resolve wallet to creator ID
   const creator = await prisma.creatorProfile.findFirst({
      where: {
         user: {
            stellarWallet: {
               address: wallet,
            },
         },
      },
      select: { id: true },
   });

   if (!creator) {
      throw new CreatorNotFoundError(wallet);
   }

   // Validate limit
   const maxLimit = 100;
   const safeLimit = Math.min(Math.max(limit, 1), maxLimit);
   const fetchLimit = safeLimit + 1;

   // Build query
   let whereClause: any = { creatorId: creator.id };

   if (cursor) {
      const lastItem = await prisma.creatorReputationHistory.findUnique({
         where: { id: cursor },
         select: { recordedAt: true },
      });

      if (lastItem) {
         // Get items recorded after the cursor
         whereClause.recordedAt = { gt: lastItem.recordedAt };
      }
   }

   const history = await prisma.creatorReputationHistory.findMany({
      where: whereClause,
      select: {
         id: true,
         score: true,
         tier: true,
         eventType: true,
         ledger: true,
         recordedAt: true,
      },
      orderBy: { recordedAt: 'asc' },
      take: fetchLimit,
   });

   const hasMore = history.length > safeLimit;
   const items = history.slice(0, safeLimit);

   const result: ReputationHistoryResponse = {
      items: items.map(item => ({
         score: item.score,
         tier: item.tier,
         eventType: item.eventType,
         ledger: item.ledger || undefined,
         recordedAt: item.recordedAt.toISOString(),
      })),
      hasMore,
      ...(hasMore && items.length > 0 ? { cursor: items[items.length - 1].id } : {}),
   };

   return result;
}

/**
 * Record a reputation event and update the creator's score.
 * Called by the indexer when reputation-affecting events occur.
 */
export async function recordReputationEvent(
   creatorId: string,
   eventType: 'KEY_LAUNCHED' | 'MILESTONE_REACHED' | 'GOVERNANCE_VOTE' | 'KEY_DEPRECATED',
   ledger: number,
   txHash?: string
): Promise<void> {
   try {
      // Get or create reputation record
      let reputation = await prisma.creatorReputation.findUnique({
         where: { creatorId },
      });

      if (!reputation) {
         reputation = await prisma.creatorReputation.create({
            data: { creatorId },
         });
      }

      // Update breakdown
      const updateData: any = {};
      switch (eventType) {
         case 'KEY_LAUNCHED':
            updateData.keyLaunches = { increment: 1 };
            break;
         case 'MILESTONE_REACHED':
            updateData.milestonesReached = { increment: 1 };
            break;
         case 'GOVERNANCE_VOTE':
            updateData.governanceVotes = { increment: 1 };
            break;
         case 'KEY_DEPRECATED':
            updateData.deprecations = { increment: 1 };
            break;
      }

      // Get updated breakdown
      const updated = await prisma.creatorReputation.update({
         where: { creatorId },
         data: updateData,
         select: {
            keyLaunches: true,
            milestonesReached: true,
            governanceVotes: true,
            deprecations: true,
         },
      });

      // Calculate new score
      const newScore = calculateScore(updated);
      const newTier = calculateTier(newScore);

      // Update score and tier
      const finalReputation = await prisma.creatorReputation.update({
         where: { creatorId },
         data: {
            currentScore: newScore,
            tier: newTier,
         },
      });

      // Record history entry
      await prisma.creatorReputationHistory.create({
         data: {
            reputationId: finalReputation.id,
            creatorId,
            score: newScore,
            tier: newTier,
            eventType,
            ledger,
            txHash,
         },
      });

      // Invalidate cache
      await cacheInvalidate(`creator-reputation:${creatorId}`);

      logger.info(
         {
            creatorId,
            eventType,
            newScore,
            newTier,
            ledger,
            txHash,
         },
         'Reputation event recorded'
      );
   } catch (error) {
      logger.error(
         { error, creatorId, eventType, ledger },
         'Failed to record reputation event'
      );
      throw error;
   }
}

/**
 * Rebuild reputation for a creator from activity history.
 * Used for backfilling or recalculation.
 */
export async function rebuildCreatorReputation(
   creatorId: string
): Promise<CreatorReputationResponse> {
   try {
      // Count activity events
      const [
         keyLaunches,
         milestonesReached,
         governanceVotes,
         deprecations,
      ] = await Promise.all([
         prisma.activity.count({
            where: {
               creatorId,
               type: 'CREATOR_REGISTERED',
            },
         }),
         prisma.activity.count({
            where: {
               creatorId,
               type: 'SUPPLY_CAP_SET',
            },
         }),
         prisma.governanceVote.count({
            where: {
               keyId: creatorId,
            },
         }),
         prisma.creatorProfile.count({
            where: {
               id: creatorId,
               deprecatedAt: { not: null },
            },
         }),
      ]);

      const breakdown: ReputationBreakdown = {
         keyLaunches,
         milestonesReached,
         governanceVotes,
         deprecations,
      };

      const newScore = calculateScore(breakdown);
      const newTier = calculateTier(newScore);

      // Update or create reputation record
      const reputation = await prisma.creatorReputation.upsert({
         where: { creatorId },
         create: {
            creatorId,
            currentScore: newScore,
            tier: newTier,
            keyLaunches,
            milestonesReached,
            governanceVotes,
            deprecations,
         },
         update: {
            currentScore: newScore,
            tier: newTier,
            keyLaunches,
            milestonesReached,
            governanceVotes,
            deprecations,
         },
         select: {
            currentScore: true,
            tier: true,
            keyLaunches: true,
            milestonesReached: true,
            governanceVotes: true,
            deprecations: true,
         },
      });

      // Invalidate cache
      await cacheInvalidate(`creator-reputation:${creatorId}`);

      const result: CreatorReputationResponse = {
         score: reputation.currentScore,
         tier: reputation.tier,
         breakdown: {
            keyLaunches: reputation.keyLaunches,
            milestonesReached: reputation.milestonesReached,
            governanceVotes: reputation.governanceVotes,
            deprecations: reputation.deprecations,
         },
      };

      logger.info({ creatorId, ...result }, 'Creator reputation rebuilt');
      return result;
   } catch (error) {
      logger.error({ error, creatorId }, 'Failed to rebuild reputation');
      throw error;
   }
}
