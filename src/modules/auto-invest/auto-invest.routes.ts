import { Router } from 'express';
import {
   httpCreateAutoInvestRule,
   httpDeleteAutoInvestRule,
   httpEvaluateListing,
   httpListAutoInvestRules,
   httpUpdateAutoInvestRule,
} from './auto-invest.controllers';
import { requireJwtAuth } from '../../middlewares/jwt-auth.middleware';
import { validateBody } from '../../middlewares/validate-body.middleware';
import {
   CreateAutoInvestRuleSchema,
   UpdateAutoInvestRuleSchema,
} from './auto-invest.schemas';

const router = Router();

// All auto-invest routes require an authenticated JWT session. The caller's
// wallet is resolved from the token (req.user.wallet) and used to scope rule
// ownership; clients never supply a wallet identifier directly.
router.use(requireJwtAuth);

/**
 * POST /auto-invest/rules
 * Create an auto-invest rule owned by the authenticated wallet.
 */
router.post(
   '/rules',
   validateBody(CreateAutoInvestRuleSchema),
   httpCreateAutoInvestRule
);

/**
 * GET /auto-invest/rules?wallet=...
 * List active auto-invest rules for the authenticated wallet.
 */
router.get('/rules', httpListAutoInvestRules);

/**
 * PATCH /auto-invest/rules/:id
 * Partially update or toggle an auto-invest rule.
 */
router.patch(
   '/rules/:id',
   validateBody(UpdateAutoInvestRuleSchema),
   httpUpdateAutoInvestRule
);

/**
 * DELETE /auto-invest/rules/:id
 * Delete an auto-invest rule.
 */
router.delete('/rules/:id', httpDeleteAutoInvestRule);

/**
 * POST /auto-invest/evaluate/:listingId
 * Operator endpoint to trigger evaluation of a listing against rules.
 */
router.post('/evaluate/:listingId', httpEvaluateListing);

export default router;
