import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';
import { Decimal } from '@prisma/client/runtime/library';

export class KeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundError';
   }
}

export interface BuybackPoolResponse {
   creatorId: string;
   balanceXlm: string;
   lastUpdatedAt: string;
}

export interface BuybackContributionRecord {
   id: string;
   amountXlm: string;
   sourceType: string;
   ledger: number;
   txHash: string;
   createdAt: string;
}

export interface BuybackPoolHistoryResponse {
   items: BuybackContributionRecord[];
   cursor?: string;
   hasMore: boolean;
}

const CACHE_TTL_SECONDS = 30;

/**
 * Get current buyback pool balance for a creator key.
 * Returns balance synced from SellTaxCollected contract events.
 * Cached with 30s TTL.
 */
export async function getBuybackPoolBalance(
   keyId: string
): Promise<BuybackPoolResponse> {
   // Verify key exists
   const creator = await prisma.creatorProfile.findUnique({
      where: { id: keyId },
      select: { id: true },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   // Try cache first
   const cacheKey = `buyback-pool:${keyId}`;
   const cached = await cacheGetJson<BuybackPoolResponse>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   // Get or create pool
   let pool = await prisma.buybackPool.findUnique({
      where: { creatorId: keyId },
      select: {
         balanceXlm: true,
         lastUpdatedAt: true,
      },
   });

   if (!pool) {
      // Initialize new pool
      const newPool = await prisma.buybackPool.create({
         data: {
            creatorId: keyId,
            balanceXlm: new Decimal(0),
         },
         select: {
            balanceXlm: true,
            lastUpdatedAt: true,
         },
      });
      pool = newPool;
   }

   const result: BuybackPoolResponse = {
      creatorId: keyId,
      balanceXlm: pool.balanceXlm.toString(),
      lastUpdatedAt: pool.lastUpdatedAt.toISOString(),
   };

   // Cache with 30s TTL
   try {
      await cacheSetJson(cacheKey, result, CACHE_TTL_SECONDS);
   } catch (error) {
      logger.warn(
         { error, keyId },
         'Failed to cache buyback pool balance'
      );
   }

   return result;
}

/**
 * Get paginated history of buyback pool contributions.
 * Returns contributions in reverse chronological order.
 * Uses cursor-based pagination.
 */
export async function getBuybackPoolHistory(
   keyId: string,
   limit: number = 20,
   cursor?: string
): Promise<BuybackPoolHistoryResponse> {
   // Verify key exists
   const creator = await prisma.creatorProfile.findUnique({
      where: { id: keyId },
      select: { id: true },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   // Validate limit
   const maxLimit = 100;
   const safeLimit = Math.min(Math.max(limit, 1), maxLimit);
   const fetchLimit = safeLimit + 1; // Fetch one extra to detect hasMore

   // Build query
   let whereClause: any = { creatorId: keyId };

   if (cursor) {
      // Cursor is the ID of the last item; fetch items before it
      const lastItem = await prisma.buybackContribution.findUnique({
         where: { id: cursor },
         select: { createdAt: true },
      });

      if (lastItem) {
         // Get items created before the cursor's timestamp
         whereClause.createdAt = { lt: lastItem.createdAt };
      }
   }

   const contributions = await prisma.buybackContribution.findMany({
      where: whereClause,
      select: {
         id: true,
         amountXlm: true,
         sourceType: true,
         ledger: true,
         txHash: true,
         createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: fetchLimit,
   });

   // Check if there are more results
   const hasMore = contributions.length > safeLimit;
   const items = contributions.slice(0, safeLimit);

   const result: BuybackPoolHistoryResponse = {
      items: items.map(item => ({
         id: item.id,
         amountXlm: item.amountXlm.toString(),
         sourceType: item.sourceType,
         ledger: item.ledger,
         txHash: item.txHash,
         createdAt: item.createdAt.toISOString(),
      })),
      hasMore,
      ...(hasMore && items.length > 0 ? { cursor: items[items.length - 1].id } : {}),
   };

   return result;
}

/**
 * Record a sell tax collection event to the buyback pool.
 * Called by the SellTaxCollected event indexer.
 */
export async function recordBuybackContribution(
   creatorId: string,
   amountXlm: Decimal,
   ledger: number,
   txHash: string,
   eventIndex: number
): Promise<void> {
   try {
      // Get or create pool
      let pool = await prisma.buybackPool.findUnique({
         where: { creatorId },
      });

      if (!pool) {
         pool = await prisma.buybackPool.create({
            data: {
               creatorId,
               balanceXlm: amountXlm,
            },
         });
      } else {
         // Update pool balance
         pool = await prisma.buybackPool.update({
            where: { creatorId },
            data: {
               balanceXlm: {
                  increment: amountXlm,
               },
            },
         });
      }

      // Record contribution history
      await prisma.buybackContribution.create({
         data: {
            poolId: pool.id,
            creatorId,
            amountXlm,
            sourceType: 'SELL_TAX',
            ledger,
            txHash,
            eventIndex,
         },
      });

      // Invalidate cache
      await cacheInvalidate(`buyback-pool:${creatorId}`);

      logger.info(
         { creatorId, amountXlm: amountXlm.toString(), ledger, txHash },
         'Buyback pool contribution recorded'
      );
   } catch (error) {
      logger.error(
         { error, creatorId, amountXlm: amountXlm.toString() },
         'Failed to record buyback contribution'
      );
      throw error;
   }
}

/**
 * Execute a buyback from the pool (admin only).
 * This creates an execution record that will be processed by the contract.
 */
export async function executeBuybackFromPool(
   creatorId: string,
   amountXlm: Decimal,
   adminWallet: string
): Promise<{ executionId: string }> {
   // Verify key exists
   const creator = await prisma.creatorProfile.findUnique({
      where: { id: creatorId },
      select: { id: true },
   });

   if (!creator) {
      throw new KeyNotFoundError(creatorId);
   }

   // Get pool
   const pool = await prisma.buybackPool.findUnique({
      where: { creatorId },
      select: { balanceXlm: true },
   });

   if (!pool) {
      throw new Error('Buyback pool not found');
   }

   // Verify sufficient balance
   if (pool.balanceXlm.lessThan(amountXlm)) {
      throw new Error(
         `Insufficient pool balance. Available: ${pool.balanceXlm}, Requested: ${amountXlm}`
      );
   }

   // Create execution record
   const execution = await prisma.buybackExecution.create({
      data: {
         creatorId,
         amountXlm,
         executedBy: adminWallet,
         status: 'PENDING',
      },
   });

   logger.info(
      { executionId: execution.id, creatorId, amountXlm: amountXlm.toString(), adminWallet },
      'Buyback execution initiated'
   );

   return { executionId: execution.id };
}

/**
 * Complete a buyback execution after on-chain transaction.
 * Updates pool balance and execution status.
 */
export async function completeBuybackExecution(
   executionId: string,
   txHash: string
): Promise<void> {
   const execution = await prisma.buybackExecution.findUnique({
      where: { id: executionId },
   });

   if (!execution) {
      throw new Error('Execution not found');
   }

   // Deduct from pool
   const pool = await prisma.buybackPool.findUnique({
      where: { creatorId: execution.creatorId },
   });

   if (!pool) {
      throw new Error('Pool not found');
   }

   await prisma.$transaction([
      prisma.buybackPool.update({
         where: { creatorId: execution.creatorId },
         data: {
            balanceXlm: {
               decrement: execution.amountXlm,
            },
         },
      }),
      prisma.buybackExecution.update({
         where: { id: executionId },
         data: {
            status: 'COMPLETED',
            txHash,
         },
      }),
   ]);

   // Invalidate cache
   await cacheInvalidate(`buyback-pool:${execution.creatorId}`);

   logger.info(
      { executionId, creatorId: execution.creatorId, txHash },
      'Buyback execution completed'
   );
}

/**
 * Mark a buyback execution as failed.
 */
export async function failBuybackExecution(
   executionId: string,
   reason: string
): Promise<void> {
   await prisma.buybackExecution.update({
      where: { id: executionId },
      data: {
         status: 'FAILED',
         failureReason: reason,
      },
   });

   logger.warn(
      { executionId, reason },
      'Buyback execution failed'
   );
}
