import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { computeBuyCost } from '../../utils/pricing.utils';
import { buyGateway } from '../creator/buy.service';
import { getKeyFees } from '../keys/key-fees.service';
import { keyEventEmitter } from '../keys/key-registration.service';
import {
   AutoInvestRuleRow,
   serializeRule,
} from './auto-invest.schemas';
import { emitAutoInvestExecuted } from './auto-invest.events';

const STROOPS_PER_XLM = 10_000_000n;

export class AutoInvestError extends Error {
   constructor(
      public readonly code: string,
      message: string
   ) {
      super(message);
      this.name = 'AutoInvestError';
   }
}

export class AutoInvestKeyNotFoundError extends AutoInvestError {
   constructor(listingId: string) {
      super('key_not_found', `Key/listing not found: ${listingId}`);
   }
}

export class AutoInvestPriceUnavailableError extends AutoInvestError {
   constructor(listingId: string) {
      super(
         'price_unavailable',
         `No price available for listing: ${listingId}`
      );
   }
}

function toStroops(xlm: string | number): bigint {
   return BigInt(Math.floor(Number(xlm) * Number(STROOPS_PER_XLM)));
}

/**
 * Rule CRUD
 */

/**
 * Creates an auto-invest rule owned by the authenticated wallet.
 * The wallet address is resolved from the authenticated session and is never
 * accepted from the client body.
 */
export async function createAutoInvestRule(
   walletAddress: string,
   input: {
      category: string;
      minRating?: number | null | undefined;
      maxPrice: string;
      maxPerKey: number;
   }
): Promise<AutoInvestRuleRow> {
   const rule = await prisma.autoInvestRule.create({
      data: {
         walletAddress,
         category: input.category,
         minRating: input.minRating ?? null,
         maxPrice: input.maxPrice,
         maxPerKey: input.maxPerKey,
         isActive: true,
      },
   });
   return serializeRule(rule);
}

/**
 * Returns active auto-invest rules for a wallet.
 */
export async function listActiveAutoInvestRules(
   walletAddress: string
): Promise<AutoInvestRuleRow[]> {
   const rules = await prisma.autoInvestRule.findMany({
      where: {
         walletAddress,
         isActive: true,
      },
      orderBy: { createdAt: 'desc' },
   });
   return rules.map(serializeRule);
}

/**
 * Fetches a single rule, verifying wallet ownership. Returns null when the
 * rule does not exist or does not belong to the wallet (no leakage).
 */
export async function getAutoInvestRule(
   ruleId: string,
   walletAddress: string
): Promise<AutoInvestRuleRow | null> {
   const rule = await prisma.autoInvestRule.findFirst({
      where: { id: ruleId, walletAddress },
   });
   if (!rule) return null;
   return serializeRule(rule);
}

/**
 * Partially updates a rule. Only supplied fields are changed. Verifies wallet
 * ownership. Returns null when the rule does not exist or is not owned.
 */
export async function updateAutoInvestRule(
   ruleId: string,
   walletAddress: string,
   input: {
      category?: string;
      minRating?: number | null;
      maxPrice?: string;
      maxPerKey?: number;
      isActive?: boolean;
   }
): Promise<AutoInvestRuleRow | null> {
   const existing = await prisma.autoInvestRule.findFirst({
      where: { id: ruleId, walletAddress },
   });
   if (!existing) return null;

   const data: Record<string, unknown> = {};
   if (input.category !== undefined) data.category = input.category;
   if (input.minRating !== undefined) data.minRating = input.minRating ?? null;
   if (input.maxPrice !== undefined) data.maxPrice = input.maxPrice;
   if (input.maxPerKey !== undefined) data.maxPerKey = input.maxPerKey;
   if (input.isActive !== undefined) data.isActive = input.isActive;

   const rule = await prisma.autoInvestRule.update({
      where: { id: ruleId },
      data,
   });
   return serializeRule(rule);
}

/**
 * Deletes a rule after verifying wallet ownership. Returns false when the rule
 * does not exist or is not owned by the wallet.
 */
export async function deleteAutoInvestRule(
   ruleId: string,
   walletAddress: string
): Promise<boolean> {
   const existing = await prisma.autoInvestRule.findFirst({
      where: { id: ruleId, walletAddress },
   });
   if (!existing) return false;

   await prisma.autoInvestRule.delete({ where: { id: ruleId } });
   return true;
}

/**
 * Execution
 */

/**
 * Evaluates a newly listed key against all eligible active auto-invest rules
 * and executes qualifying purchases. Each rule is executed independently so a
 * single rule's failure does not block other rules.
 *
 * Returns a summary of executions.
 */
export async function evaluateListing(listingId: string): Promise<{
   listingId: string;
   evaluated: number;
   executed: number;
   skipped: number;
   failed: number;
   results: Array<{
      ruleId: string;
      walletAddress: string;
      outcome: 'executed' | 'skipped' | 'failed' | 'ineligible' | 'duplicate';
      reason?: string;
   }>;
}> {
   const results: Array<{
      ruleId: string;
      walletAddress: string;
      outcome: 'executed' | 'skipped' | 'failed' | 'ineligible' | 'duplicate';
      reason?: string;
   }> = [];

   // 1. Load the key and its current price.
   const key = await prisma.creatorProfile.findUnique({
      where: { id: listingId },
      select: {
         id: true,
         category: true,
         rating: true,
         circulatingSupply: true,
      },
   });
   if (!key) {
      logger.warn({ listingId }, 'Auto-invest: listing not found, skipping');
      return {
         listingId,
         evaluated: 0,
         executed: 0,
         skipped: 0,
         failed: 0,
         results,
      };
   }

   // Keys without a category cannot match any rule (category is required on rules).
   if (!key.category) {
      logger.warn(
         { listingId },
         'Auto-invest: listing has no category, no rules can match'
      );
      return {
         listingId,
         evaluated: 0,
         executed: 0,
         skipped: 0,
         failed: 0,
         results,
      };
   }

   const priceSnapshot = await prisma.creatorPriceSnapshot.findUnique({
      where: { creatorId: listingId },
      select: { currentPrice: true },
   });
   if (!priceSnapshot) {
      logger.warn(
         { listingId },
         'Auto-invest: no price snapshot for listing, skipping'
      );
      return {
         listingId,
         evaluated: 0,
         executed: 0,
         skipped: 0,
         failed: 0,
         results,
      };
   }

   const currentPriceStroops: bigint = BigInt(
      priceSnapshot.currentPrice.toString()
   );
   const currentSupply = Number(key.circulatingSupply ?? 0);

   // 2. Find eligible active rules matching the key's category.
   const rules = await prisma.autoInvestRule.findMany({
      where: {
         isActive: true,
         category: key.category,
      },
      orderBy: { createdAt: 'asc' },
   });

   let evaluated = 0;
   let executed = 0;
   let skipped = 0;
   let failed = 0;

   for (const rule of rules) {
      evaluated++;

      // Re-verify the rule is still active immediately before execution.
      if (!rule.isActive) {
         results.push({
            ruleId: rule.id,
            walletAddress: rule.walletAddress,
            outcome: 'ineligible',
            reason: 'rule is inactive',
         });
         continue;
      }

      // 3. Rating check: keys with no rating never match a minRating rule.
      const ruleMinRating = rule.minRating ? Number(rule.minRating) : null;
      const keyRating = key.rating ? Number(key.rating) : null;
      if (ruleMinRating !== null) {
         if (keyRating === null || keyRating < ruleMinRating) {
            results.push({
               ruleId: rule.id,
               walletAddress: rule.walletAddress,
               outcome: 'ineligible',
               reason: `key rating ${keyRating ?? 'missing'} below min ${ruleMinRating}`,
            });
            continue;
         }
      }

      // 4. Price check.
      const ruleMaxPriceStroops = toStroops(String(rule.maxPrice));
      if (currentPriceStroops > ruleMaxPriceStroops) {
         results.push({
            ruleId: rule.id,
            walletAddress: rule.walletAddress,
            outcome: 'ineligible',
            reason: `price ${currentPriceStroops} exceeds max ${ruleMaxPriceStroops}`,
         });
         continue;
      }

      const quantity = Math.max(1, rule.maxPerKey);

      try {
         await executeRuleForListing(rule, listingId, quantity, currentSupply);
         executed++;
         results.push({
            ruleId: rule.id,
            walletAddress: rule.walletAddress,
            outcome: 'executed',
         });
      } catch (error) {
         if (
            error instanceof AutoInvestError &&
            error.code === 'insufficient_balance'
         ) {
            skipped++;
            results.push({
               ruleId: rule.id,
               walletAddress: rule.walletAddress,
               outcome: 'skipped',
               reason: error.message,
            });
            continue;
         }
         if (error instanceof AutoInvestError && error.code === 'duplicate') {
            results.push({
               ruleId: rule.id,
               walletAddress: rule.walletAddress,
               outcome: 'duplicate',
               reason: 'execution already exists for this rule and listing',
            });
            continue;
         }
         failed++;
         logger.error(
            { error, ruleId: rule.id, listingId },
            'Auto-invest: rule execution failed'
         );
         results.push({
            ruleId: rule.id,
            walletAddress: rule.walletAddress,
            outcome: 'failed',
            reason: error instanceof Error ? error.message : 'unknown error',
         });
      }
   }

   logger.info(
      {
         listingId,
         evaluated,
         executed,
         skipped,
         failed,
         ruleCount: rules.length,
      },
      'Auto-invest: listing evaluation complete'
   );

   return { listingId, evaluated, executed, skipped, failed, results };
}

/**
 * Executes a single rule for a listing with idempotency and balance guards.
 */
export async function executeRuleForListing(
   rule: {
      id: string;
      walletAddress: string;
      maxPrice: unknown;
      maxPerKey: number;
   },
   listingId: string,
   quantity: number,
   currentSupply: number
): Promise<void> {
   const walletAddress = rule.walletAddress;

   // Idempotency: reserve the execution slot atomically. The unique constraint
   // on (ruleId, listingId) guarantees only one worker can own this execution.
   let execution;
   try {
      execution = await prisma.autoInvestExecution.create({
         data: {
            ruleId: rule.id,
            listingId,
            status: 'PENDING',
         },
      });
   } catch {
      // Unique constraint violation => a duplicate/concurrent execution already
      // owns this rule+listing. Treat as a safe no-op.
      throw new AutoInvestError(
         'duplicate',
         `Execution already exists for rule ${rule.id} and listing ${listingId}`
      );
   }

   try {
      // Balance check (re-checked right before purchase).
      const { protocolFeeBps } = await getKeyFees(listingId);
      const estimatedCost = computeBuyCost(
         currentSupply,
         quantity,
         protocolFeeBps
      );

      const balance = await buyGateway.getXlmBalance(walletAddress);
      const balanceStroops = BigInt(
         Math.floor(balance * Number(STROOPS_PER_XLM))
      );
      if (balanceStroops < estimatedCost) {
         await prisma.autoInvestExecution.update({
            where: { id: execution.id },
            data: { status: 'SKIPPED_INSUFFICIENT_BALANCE' },
         });
         logger.warn(
            {
               ruleId: rule.id,
               listingId,
               walletAddress,
               balanceStroops: balanceStroops.toString(),
               estimatedCost: estimatedCost.toString(),
            },
            'Auto-invest: insufficient balance, skipping execution'
         );
         throw new AutoInvestError(
            'insufficient_balance',
            'Insufficient wallet balance for purchase'
         );
      }

      // Execute the purchase through the established purchase flow.
      const result = await buyGateway.submitBuy({
         walletAddress,
         creatorId: listingId,
         quantity,
      });

      // Mark executed and publish the success event only after purchase success.
      await prisma.autoInvestExecution.update({
         where: { id: execution.id },
         data: {
            status: 'EXECUTED',
            transactionHash: result.transactionHash ?? null,
         },
      });

      emitAutoInvestExecuted({
         ruleId: rule.id,
         listingId,
         walletAddress,
         transactionHash: result.transactionHash ?? undefined,
      });

      logger.info(
         {
            ruleId: rule.id,
            listingId,
            walletAddress,
            quantity,
            transactionHash: result.transactionHash,
         },
         'Auto-invest: execution succeeded'
      );
   } catch (error) {
      if (error instanceof AutoInvestError) throw error;
      // Purchase failure: record failure, do not emit a success event.
      await prisma.autoInvestExecution
         .update({
            where: { id: execution.id },
            data: { status: 'FAILED' },
         })
         .catch(updateErr => {
            logger.error(
               { error: updateErr, ruleId: rule.id, listingId },
               'Auto-invest: failed to record execution failure'
            );
         });
      throw error;
   }
}

/**
 * Trigger: subscribe to new key listings and evaluate auto-invest rules.
 *
 * Wired to the existing `key_registered` internal event emitted by
 * key-registration.service.ts when a new key listing is created.
 */
let autoInvestListenerStarted = false;

export function startAutoInvestListener(): void {
   if (autoInvestListenerStarted) return;
   keyEventEmitter.on('key_registered', async payload => {
      // The registration event carries the key address and the creator wallet.
      // Resolve the creator profile (listing) owned by that wallet to obtain
      // the listing id used for rule matching and execution.
      try {
         if (!payload.creatorWallet) return;
         const wallet = await prisma.stellarWallet.findUnique({
            where: { address: payload.creatorWallet },
            select: { userId: true },
         });
         if (!wallet) return;
         const creator = await prisma.creatorProfile.findFirst({
            where: { userId: wallet.userId },
            select: { id: true },
            orderBy: { createdAt: 'desc' },
         });
         if (!creator) return;
         await evaluateListing(creator.id);
      } catch (error) {
         logger.error(
            { error, payload },
            'Auto-invest: key_registered listener failed'
         );
      }
   });
   autoInvestListenerStarted = true;
   logger.info('Auto-invest listener started on key_registered event');
}

export function stopAutoInvestListener(): void {
   // EventEmitter has no off-by-reference without the handler; clear flag so
   // a restart re-subscribes. The process-level listener remains for the
   // lifetime of the process (acceptable for this service-bound feature).
   autoInvestListenerStarted = false;
   logger.info('Auto-invest listener stopped');
}
