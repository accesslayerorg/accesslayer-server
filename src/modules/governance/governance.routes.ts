import { Router } from 'express';
import { EscalatingProposalsQuerySchema } from './governance-escalation.schemas';
import { getEscalatingProposals } from './governance-escalation.service';
import {
   sendSuccess,
   sendValidationError,
} from '../../utils/api-response.utils';
import { zodIssuesToDetails } from '../../utils/api-response.utils';

const router = Router();

/**
 * GET /governance/proposals/escalating
 *
 * Proposals currently in escalation (escalationCount > 0, status = active),
 * showing extended deadline, escalation count, and participation rate.
 * Cursor-paginated.
 */
router.get('/proposals/escalating', async (req, res, next) => {
   const parsed = EscalatingProposalsQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const result = await getEscalatingProposals(parsed.data.cursor);
      sendSuccess(res, result);
   } catch (error) {
      next(error);
   }
});

export default router;
