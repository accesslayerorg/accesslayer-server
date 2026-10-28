import type { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../../middlewares/jwt-auth.middleware';
import {
   sendSuccess,
   sendNotFound,
   sendForbidden,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { logger } from '../../utils/logger.utils';
import {
   createAutoInvestRule,
   deleteAutoInvestRule,
   evaluateListing,
   getAutoInvestRule,
   listActiveAutoInvestRules,
   updateAutoInvestRule,
} from './auto-invest.service';
import {
   CreateAutoInvestRuleSchema,
   UpdateAutoInvestRuleSchema,
   AutoInvestRuleQuerySchema,
   AutoInvestRuleParamsSchema,
} from './auto-invest.schemas';

/**
 * Ensure the caller is authorized to act on the given wallet address.
 * The wallet address is always resolved from the authenticated JWT; a
 * client-supplied wallet identifier is never trusted without this check.
 */
function assertWalletOwnership(
   req: AuthenticatedRequest,
   res: Response,
   walletAddress: string
): boolean {
   if (
      !req.user ||
      req.user.wallet.toLowerCase() !== walletAddress.toLowerCase()
   ) {
      sendForbidden(
         res,
         'Authenticated wallet does not own the requested wallet.'
      );
      return false;
   }
   return true;
}

/**
 * POST /auto-invest/rules
 * Create an auto-invest rule owned by the authenticated wallet.
 */
export async function httpCreateAutoInvestRule(
   req: AuthenticatedRequest,
   res: Response,
   next: NextFunction
): Promise<void> {
   const walletAddress = req.user!.wallet;

   const parsed = CreateAutoInvestRuleSchema.safeParse(req.body);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid auto-invest rule request',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const rule = await createAutoInvestRule(walletAddress, parsed.data);
      sendSuccess(res, rule, 201, 'Auto-invest rule created');
   } catch (error) {
      logger.error({ error, walletAddress }, 'Create auto-invest rule failed');
      next(error);
   }
}

/**
 * GET /auto-invest/rules?wallet=...
 * List active auto-invest rules for the authenticated wallet.
 */
export async function httpListAutoInvestRules(
   req: AuthenticatedRequest,
   res: Response,
   next: NextFunction
): Promise<void> {
   const parsed = AutoInvestRuleQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   const requestedWallet = parsed.data.wallet;
   if (!assertWalletOwnership(req, res, requestedWallet)) return;

   try {
      const rules = await listActiveAutoInvestRules(requestedWallet);
      sendSuccess(res, rules);
   } catch (error) {
      logger.error(
         { error, walletAddress: requestedWallet },
         'List auto-invest rules failed'
      );
      next(error);
   }
}

/**
 * PATCH /auto-invest/rules/:id
 * Partially update or toggle an auto-invest rule.
 */
export async function httpUpdateAutoInvestRule(
   req: AuthenticatedRequest,
   res: Response,
   next: NextFunction
): Promise<void> {
   const walletAddress = req.user!.wallet;

   const paramsParsed = AutoInvestRuleParamsSchema.safeParse(req.params);
   if (!paramsParsed.success) {
      sendValidationError(
         res,
         'Invalid rule ID',
         zodIssuesToDetails(paramsParsed.error.issues)
      );
      return;
   }

   const parsed = UpdateAutoInvestRuleSchema.safeParse(req.body);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid auto-invest rule update',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   const ruleId = paramsParsed.data.id;

   const existing = await getAutoInvestRule(ruleId, walletAddress);
   if (!existing) {
      sendNotFound(res, 'Auto-invest rule');
      return;
   }

   try {
      const rule = await updateAutoInvestRule(ruleId, walletAddress, {
         category: parsed.data.category,
         minRating: parsed.data.minRating ?? null,
         maxPrice: parsed.data.maxPrice,
         maxPerKey: parsed.data.maxPerKey,
         isActive: parsed.data.isActive,
      });
      sendSuccess(res, rule, 200, 'Auto-invest rule updated');
   } catch (error) {
      logger.error(
         { error, ruleId, walletAddress },
         'Update auto-invest rule failed'
      );
      next(error);
   }
}

/**
 * DELETE /auto-invest/rules/:id
 * Delete an auto-invest rule.
 */
export async function httpDeleteAutoInvestRule(
   req: AuthenticatedRequest,
   res: Response
): Promise<void> {
   const walletAddress = req.user!.wallet;

   const paramsParsed = AutoInvestRuleParamsSchema.safeParse(req.params);
   if (!paramsParsed.success) {
      sendValidationError(
         res,
         'Invalid rule ID',
         zodIssuesToDetails(paramsParsed.error.issues)
      );
      return;
   }

   const ruleId = paramsParsed.data.id;

   const deleted = await deleteAutoInvestRule(ruleId, walletAddress);
   if (!deleted) {
      sendNotFound(res, 'Auto-invest rule');
      return;
   }

   sendSuccess(res, { id: ruleId }, 200, 'Auto-invest rule deleted');
}

/**
 * POST /auto-invest/evaluate/:listingId
 * (Operator) Trigger evaluation of a listing against auto-invest rules.
 */
export async function httpEvaluateListing(
   req: AuthenticatedRequest,
   res: Response,
   next: NextFunction
): Promise<void> {
   const listingId = String(req.params.listingId);
   try {
      const result = await evaluateListing(listingId);
      sendSuccess(res, result, 200, 'Auto-invest listing evaluated');
   } catch (error) {
      logger.error({ error, listingId }, 'Evaluate listing failed');
      next(error);
   }
}
