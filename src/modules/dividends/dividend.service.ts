import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { Decimal } from '@prisma/client/runtime/library';
import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';
import {
   onContractEvent,
   CONTRACT_EVENTS,
} from '../contracts/contract-events.utils';
import {
   Account,
   Address,
   Contract,
   Networks,
   TransactionBuilder,
} from '@stellar/stellar-base';
import { envConfig } from '../../config';

/**
 * Dividend distribution with calculated fields for API responses.
 */
export interface DividendDistributionRecord {
   id: string;
   creatorId: string;
   distributionDate: Date | string;
   totalAmount: number | Decimal | string;
   holderCount: number;
   perKeyAmount: number | Decimal | string;
   distributedAt: Date | string;
}

/**
 * Dividend claim record for holder breakdown.
 */
export interface DividendClaimRecord {
   id: string;
   recipientAddress: string;
   amountXlm: number | Decimal | string;
   claimedAt: Date | string | null;
}

export interface GetDividendDistributionsInput {
   creatorId: string;
   limit?: number;
   cursor?: string;
}

export interface GetDividendDistributionsResult {
   distributions: DividendDistributionRecord[];
   nextCursor?: string;
   hasMore: boolean;
}

/**
 * Cache key prefix for dividend distribution history.
 */
export const DIVIDEND_HISTORY_CACHE_PREFIX = 'dividends:history';
export const DIVIDEND_HISTORY_CACHE_TTL_SECONDS = 60;

/**
 * Invalidate cached dividend distribution history.
 */
export async function invalidateDividendHistoryCache(
   keyId?: string
): Promise<void> {
   if (keyId) {
      await cacheInvalidate(
         `${DIVIDEND_HISTORY_CACHE_PREFIX}:${keyId}:*`,
         `${DIVIDEND_HISTORY_CACHE_PREFIX}:${keyId}*`
      );
   } else {
      await cacheInvalidate(`${DIVIDEND_HISTORY_CACHE_PREFIX}:*`);
   }
}

/**
 * Invalidate all dividend related caches (history and holder aggregates).
 */
export async function invalidateDividendCache(
   keyId?: string,
   wallet?: string
): Promise<void> {
   const patterns = [
      `${DIVIDEND_HISTORY_CACHE_PREFIX}:*`,
      'dividends:holder:*',
   ];
   if (keyId) {
      patterns.push(
         `${DIVIDEND_HISTORY_CACHE_PREFIX}:${keyId}:*`,
         `${DIVIDEND_HISTORY_CACHE_PREFIX}:${keyId}*`
      );
   }
   if (wallet) {
      patterns.push(
         `dividends:holder:${wallet}:*`,
         `dividends:holder:${wallet}*`
      );
   }
   await cacheInvalidate(...patterns);
}

// Auto-invalidate cache after claim transactions confirm on-chain
onContractEvent(CONTRACT_EVENTS.TX_CONFIRMED, async payload => {
   if (payload.operation === 'claim') {
      try {
         await invalidateDividendCache(undefined, payload.submitterWallet);
         logger.info(
            { submitterWallet: payload.submitterWallet, txHash: payload.txHash },
            'Invalidated dividend cache following confirmed claim transaction'
         );
      } catch (err) {
         logger.warn(
            { error: err, submitterWallet: payload.submitterWallet },
            'Failed to invalidate dividend cache on claim confirmation'
         );
      }
   }
});

/**
 * Retrieves dividend distributions for a creator with cursor-based pagination.
 * Caches distribution history with a 60-second TTL.
 * Returns distributions sorted by distributionDate descending.
 */
export async function getDividendDistributions(
   input: GetDividendDistributionsInput
): Promise<GetDividendDistributionsResult> {
   const limit = Math.min(input.limit || 50, 100); // Max 100 per page
   const cacheKey = `${DIVIDEND_HISTORY_CACHE_PREFIX}:${input.creatorId}:${limit}:${input.cursor || 'first'}`;

   // Check cache first
   const cached = await cacheGetJson<GetDividendDistributionsResult>(cacheKey);
   if (cached) {
      return cached;
   }

   const take = limit + 1; // Fetch one extra to detect hasMore

   try {
      const distributions = await prisma.dividendDistribution.findMany({
         where: { creatorId: input.creatorId },
         orderBy: [{ distributionDate: 'desc' }, { id: 'desc' }],
         take,
         skip: input.cursor ? 1 : 0,
         cursor: input.cursor ? { id: input.cursor } : undefined,
      });

      const hasMore = distributions.length > limit;
      const result = distributions.slice(0, limit);
      const nextCursor =
         hasMore && result.length > 0
            ? result[result.length - 1].id
            : undefined;

      const records: DividendDistributionRecord[] = result.map(dist => ({
         id: dist.id,
         creatorId: dist.creatorId,
         distributionDate: dist.distributionDate,
         totalAmount: dist.totalAmountXlm,
         holderCount: dist.holderCount,
         perKeyAmount: dist.perKeyAmountXlm,
         distributedAt: dist.distributionDate,
      }));

      const responseResult: GetDividendDistributionsResult = {
         distributions: records,
         nextCursor,
         hasMore,
      };

      // Set cache with 60s TTL
      await cacheSetJson(
         cacheKey,
         responseResult,
         DIVIDEND_HISTORY_CACHE_TTL_SECONDS
      );

      return responseResult;
   } catch (error) {
      logger.error({ error, input }, 'Failed to get dividend distributions');
      throw error;
   }
}

export interface GetDividendClaimsInput {
   distributionId: string;
   limit?: number;
   cursor?: string;
}

export interface GetDividendClaimsResult {
   claims: DividendClaimRecord[];
   nextCursor?: string;
   hasMore: boolean;
}

/**
 * Retrieves dividend claims for a specific distribution with cursor-based pagination.
 * Returns claims sorted by recipientAddress ascending for deterministic ordering.
 */
export async function getDividendClaims(
   input: GetDividendClaimsInput
): Promise<GetDividendClaimsResult> {
   const limit = Math.min(input.limit || 50, 100); // Max 100 per page
   const take = limit + 1; // Fetch one extra to detect hasMore

   try {
      const claims = await prisma.dividendClaim.findMany({
         where: { distributionId: input.distributionId },
         orderBy: [{ recipientAddress: 'asc' }, { id: 'asc' }],
         take,
         skip: input.cursor ? 1 : 0,
         cursor: input.cursor ? { id: input.cursor } : undefined,
      });

      const hasMore = claims.length > limit;
      const result = claims.slice(0, limit);
      const nextCursor =
         hasMore && result.length > 0
            ? result[result.length - 1].id
            : undefined;

      const records: DividendClaimRecord[] = result.map(claim => ({
         id: claim.id,
         recipientAddress: claim.recipientAddress,
         amountXlm: claim.amountXlm,
         claimedAt: claim.claimedAt,
      }));

      return {
         claims: records,
         nextCursor,
         hasMore,
      };
   } catch (error) {
      logger.error({ error, input }, 'Failed to get dividend claims');
      throw error;
   }
}

/**
 * Checks if a distribution exists and returns it.
 */
export async function getDividendDistributionById(
   distributionId: string
): Promise<{
   id: string;
   creatorId: string;
} | null> {
   return prisma.dividendDistribution.findUnique({
      where: { id: distributionId },
      select: { id: true, creatorId: true },
   });
}

/**
 * Verifies that a creator exists.
 */
export async function creatorExists(creatorId: string): Promise<boolean> {
   const creator = await prisma.creatorProfile.findUnique({
      where: { id: creatorId },
      select: { id: true },
   });
   return !!creator;
}

export class InsufficientBalanceError extends Error {
   constructor(
      message = 'Insufficient wallet balance to cover dividend distribution'
   ) {
      super(message);
      this.name = 'InsufficientBalanceError';
   }
}

export async function createDividendDistribution(params: {
   creatorId: string;
   totalAmount: number;
   creatorWallet: string;
   txHash?: string;
   ledger?: number;
}): Promise<{
   distributionId: string;
   totalAmount: number;
   holderCount: number;
   perKeyAmount: number;
}> {
   const {
      creatorId,
      totalAmount,
      creatorWallet,
      txHash = `tx-${Date.now()}`,
      ledger = 1,
   } = params;

   // 1. Verify creator exists
   const creator = await prisma.creatorProfile.findUnique({
      where: { id: creatorId },
      include: { user: { include: { stellarWallet: true } } },
   });

   if (!creator) {
      throw new Error('Creator not found');
   }

   // 2. Wallet balance check: check if creator wallet has insufficient balance
   // If stellarWallet has a cached balance or we query keyOwnership
   const wallet = creator.user?.stellarWallet;
   if (wallet && (wallet as any).balance !== undefined) {
      const balance = Number((wallet as any).balance);
      if (balance < totalAmount) {
         throw new InsufficientBalanceError();
      }
   }

   // 3. Fetch active key holders
   const holders = await prisma.keyOwnership.findMany({
      where: {
         creatorId,
         balance: { gt: 0 },
      },
   });

   const holderCount = holders.length;
   let totalKeys = 0;
   for (const h of holders) {
      totalKeys += Number(h.balance);
   }

   const perKeyAmount = totalKeys > 0 ? totalAmount / totalKeys : 0;
   const now = new Date();

   // 4. Create DividendDistribution record
   const dist = await prisma.dividendDistribution.create({
      data: {
         creatorId,
         distributionDate: now,
         totalAmountXlm: totalAmount,
         holderCount,
         perKeyAmountXlm: perKeyAmount,
         ledger,
         txHash,
      },
   });

   // 5. Create per-holder claim records
   if (holders.length > 0) {
      await prisma.dividendClaim.createMany({
         data: holders.map(h => ({
            distributionId: dist.id,
            recipientAddress: h.ownerAddress,
            amountXlm: Number(h.balance) * perKeyAmount,
         })),
      });

      // Write activity_log records for each recipient
      await prisma.activityLog.createMany({
         data: holders.map(h => ({
            type: 'dividend',
            actor: h.ownerAddress,
            keyId: creatorId,
            creatorName: creator.displayName || creator.handle,
            amount: Number(h.balance) * perKeyAmount,
            txHash,
            timestamp: now,
            payload: {
               distributionId: dist.id,
               perKeyAmount,
               holderKeys: Number(h.balance),
            },
         })),
         skipDuplicates: true,
      });
   }

   // Also record general activity
   await prisma.activity.create({
      data: {
         type: 'DIVIDEND_DISTRIBUTED',
         actor: creatorWallet,
         creatorId,
         payload: {
            distributionId: dist.id,
            totalAmount,
            holderCount,
            perKeyAmount,
            txHash,
         },
         createdAt: now,
      },
   });

   logger.info(
      {
         distributionId: dist.id,
         creatorId,
         totalAmount,
         holderCount,
         perKeyAmount,
      },
      'Dividend distributed successfully'
   );

   try {
      const { invalidateCreatorDashboardCache } =
         await import('../creator/creator-dashboard.service');
      await invalidateCreatorDashboardCache(creatorId);
   } catch {
      // Non-critical cache invalidation failure
   }

   try {
      await invalidateDividendCache(creatorId, creatorWallet);
   } catch {
      // Non-critical cache invalidation failure
   }

   return {
      distributionId: dist.id,
      totalAmount,
      holderCount,
      perKeyAmount,
   };
}

export interface HolderDividendsResult {
   wallet: string;
   totalPending: number;
   totalClaimed: number;
   total: number;
   keys: Array<{
      keyId: string;
      pending: number;
      claimed: number;
      total: number;
      pendingAmount?: number;
      claimedAmount?: number;
      totalAmount?: number;
   }>;
}

/**
 * Aggregates pending and claimed dividends for a wallet across all held keys.
 */
export async function getHolderDividends(input: {
   wallet: string;
}): Promise<HolderDividendsResult> {
   const { wallet } = input;
   const cacheKey = `dividends:holder:${wallet}`;
   const cached = await cacheGetJson<HolderDividendsResult>(cacheKey);
   if (cached) {
      return cached;
   }

   // 1. Fetch all claims for this wallet
   const claims = await prisma.dividendClaim.findMany({
      where: { recipientAddress: wallet },
      include: {
         distribution: {
            select: {
               id: true,
               creatorId: true,
            },
         },
      },
   });

   // 2. Fetch all key holdings for this wallet (balance > 0)
   const holdings = await prisma.keyOwnership.findMany({
      where: {
         ownerAddress: wallet,
         balance: { gt: 0 },
      },
      select: {
         creatorId: true,
      },
   });

   // 3. Aggregate per key
   const perKeyMap = new Map<
      string,
      { pending: number; claimed: number; total: number }
   >();

   // Initialize keys from holdings
   for (const h of holdings) {
      if (!perKeyMap.has(h.creatorId)) {
         perKeyMap.set(h.creatorId, { pending: 0, claimed: 0, total: 0 });
      }
   }

   // Add claims per key
   for (const c of claims) {
      const keyId = c.distribution?.creatorId;
      if (!keyId) continue;

      if (!perKeyMap.has(keyId)) {
         perKeyMap.set(keyId, { pending: 0, claimed: 0, total: 0 });
      }

      const entry = perKeyMap.get(keyId)!;
      const amt = Number(c.amountXlm);
      if (c.claimedAt) {
         entry.claimed += amt;
      } else {
         entry.pending += amt;
      }
      entry.total = entry.pending + entry.claimed;
   }

   let totalPending = 0;
   let totalClaimed = 0;

   const keys = Array.from(perKeyMap.entries()).map(([keyId, data]) => {
      const pending = Number(data.pending.toFixed(7));
      const claimed = Number(data.claimed.toFixed(7));
      const total = Number(data.total.toFixed(7));

      totalPending += pending;
      totalClaimed += claimed;

      return {
         keyId,
         pending,
         claimed,
         total,
         pendingAmount: pending,
         claimedAmount: claimed,
         totalAmount: total,
      };
   });

   // Deterministic sort by keyId
   keys.sort((a, b) => a.keyId.localeCompare(b.keyId));

   totalPending = Number(totalPending.toFixed(7));
   totalClaimed = Number(totalClaimed.toFixed(7));
   const grandTotal = Number((totalPending + totalClaimed).toFixed(7));

   const result: HolderDividendsResult = {
      wallet,
      totalPending,
      totalClaimed,
      total: grandTotal,
      keys,
   };

   // Cache for 60s
   await cacheSetJson(cacheKey, result, 60);

   return result;
}

export interface BuildClaimTransactionInput {
   keyId: string;
   claimantWallet: string;
   contractId?: string;
}

export interface BuildClaimTransactionResult {
   transaction: string;
   transactionXdr: string;
   unsignedTransaction: string;
   networkPassphrase: string;
   keyId: string;
   claimantWallet: string;
   pendingAmount: number;
}

/**
 * Builds an unsigned Soroban claim transaction for a key and claimant wallet.
 */
export async function buildClaimTransaction(
   input: BuildClaimTransactionInput
): Promise<BuildClaimTransactionResult> {
   const { keyId, claimantWallet, contractId } = input;

   // 1. Calculate pending dividend amount if any
   let pendingAmount = 0;
   try {
      const pendingClaims = await prisma.dividendClaim.findMany({
         where: {
            recipientAddress: claimantWallet,
            claimedAt: null,
            distribution: { creatorId: keyId },
         },
         select: { amountXlm: true },
      });
      pendingAmount = pendingClaims.reduce(
         (acc, c) => acc + Number(c.amountXlm),
         0
      );
      pendingAmount = Number(pendingAmount.toFixed(7));
   } catch {
      // In tests or when claims table is empty, pendingAmount remains 0
   }

   // 2. Determine target Soroban contract address
   const networkPassphrase =
      envConfig.STELLAR_NETWORK === 'mainnet'
         ? Networks.PUBLIC
         : Networks.TESTNET;

   let targetContractId = contractId;
   if (!targetContractId) {
      if (keyId.startsWith('C') && keyId.length === 56) {
         targetContractId = keyId;
      } else {
         try {
            const regKey = await prisma.registeredKey.findFirst({
               where: {
                  OR: [{ id: keyId }, { keyAddress: keyId }],
               },
               select: { keyAddress: true },
            });
            if (regKey && regKey.keyAddress.startsWith('C')) {
               targetContractId = regKey.keyAddress;
            }
         } catch {
            // Ignore DB lookup error
         }
      }
   }

   const finalContractId =
      targetContractId ||
      (envConfig as any).STELLAR_DIVIDEND_CONTRACT_ID ||
      'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

   // 3. Build Soroban contract call operation
   const contract = new Contract(finalContractId);
   const claimantAddress = new Address(claimantWallet);
   const op = contract.call(
      'claim_dividend',
      claimantAddress.toScVal()
   );

   // 4. Build unsigned Stellar Transaction
   const tx = new TransactionBuilder(new Account(claimantWallet, '0'), {
      fee: '100',
      networkPassphrase,
   })
      .addOperation(op)
      .setTimeout(300)
      .build();

   const unsignedXdr = tx.toXDR();

   return {
      transaction: unsignedXdr,
      transactionXdr: unsignedXdr,
      unsignedTransaction: unsignedXdr,
      networkPassphrase,
      keyId,
      claimantWallet,
      pendingAmount,
   };
}

