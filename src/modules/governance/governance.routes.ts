import { Router } from 'express';
import { EscalatingProposalsQuerySchema } from './governance-escalation.schemas';
import { getEscalatingProposals } from './governance-escalation.service';
import {
   CastGovernanceVoteSchema,
   CreateGovernanceProposalSchema,
   GovernanceVoteWeightQuerySchema,
   ListGovernanceProposalsQuerySchema,
} from './governance-proposals.schemas';
import {
   castGovernanceVote,
   createGovernanceProposal,
   DuplicateGovernanceVoteError,
   getProposalVotingWeight,
   GovernanceKeyNotFoundError,
   GovernanceProposalNotFoundError,
   InvalidVoteOptionError,
   listGovernanceProposals,
   NoSnapshotVotingPowerError,
   NotKeyCreatorError,
   VotingPeriodEndedError,
   WalletNotRegisteredError,
} from './governance-proposals.service';
import {
   sendSuccess,
   sendValidationError,
   sendNotFound,
   sendForbidden,
   sendConflict,
   sendError,
   zodIssuesToDetails,
   ErrorCode,
} from '../../utils/api-response.utils';
import {
   AuthenticatedRequest,
   requireJwtAuth,
} from '../../middlewares/jwt-auth.middleware';
import { validateBody } from '../../middlewares/validate-body.middleware';

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

/**
 * GET /governance/proposals/:id/weight?wallet=
 *
 * Returns the frozen snapshot voting weight for a wallet on the given
 * proposal (#1036). Live balance changes after the snapshot do not affect the
 * returned weight.
 */
router.get('/proposals/:id/weight', async (req, res, next) => {
   const parsed = GovernanceVoteWeightQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const result = await getProposalVotingWeight(
         String(req.params.id),
         parsed.data.wallet
      );
      sendSuccess(res, result);
   } catch (error) {
      if (error instanceof GovernanceProposalNotFoundError) {
         sendNotFound(res, 'Proposal');
         return;
      }
      next(error);
   }
});

/**
 * GET /governance/proposals
 *
 * List proposals with vote tallies and status, newest first. Expired
 * proposals are closed (quorum computed) before listing. Filterable by
 * `status` and `keyId`, cursor-paginated.
 */
router.get('/proposals', async (req, res, next) => {
   const parsed = ListGovernanceProposalsQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const result = await listGovernanceProposals(parsed.data);
      sendSuccess(res, result);
   } catch (error) {
      next(error);
   }
});

/**
 * POST /governance/proposals
 *
 * Create a proposal and freeze the snapshot voting weights. Requires a JWT
 * for the key creator. The snapshot block is the latest indexed ledger and
 * each wallet's staked balance for the key at that point is recorded, so
 * later holdings changes cannot affect voting weight.
 *
 * - 401 when the caller's wallet is not registered
 * - 403 when the caller is not the key creator
 * - 404 when the key does not exist
 */
router.post(
   '/proposals',
   requireJwtAuth,
   validateBody(CreateGovernanceProposalSchema),
   async (req: AuthenticatedRequest, res, next) => {
      try {
         const result = await createGovernanceProposal(
            req.body,
            req.user!.wallet
         );
         sendSuccess(
            res,
            {
               ...result,
               expiresAt: result.expiresAt.toISOString(),
               createdAt: result.createdAt.toISOString(),
            },
            201
         );
      } catch (error) {
         if (error instanceof GovernanceKeyNotFoundError) {
            sendNotFound(res, 'Key');
            return;
         }
         if (error instanceof WalletNotRegisteredError) {
            sendError(res, 401, ErrorCode.UNAUTHORIZED, error.message);
            return;
         }
         if (error instanceof NotKeyCreatorError) {
            sendForbidden(res, error.message);
            return;
         }
         next(error);
      }
   }
);

/**
 * POST /governance/proposals/:id/vote
 *
 * Cast a vote weighted by the caller's snapshot staked balance. `:id` accepts
 * the proposal's internal id or its `proposalId`.
 *
 * - 403 when the caller had no staked balance at the snapshot block
 * - 404 when the proposal does not exist
 * - 409 when the proposal is closed / past its deadline, or the wallet has
 *   already voted
 * - 422 when optionIndex is out of range
 */
router.post(
   '/proposals/:id/vote',
   requireJwtAuth,
   validateBody(CastGovernanceVoteSchema),
   async (req: AuthenticatedRequest, res, next) => {
      try {
         const result = await castGovernanceVote(
            String(req.params.id),
            req.user!.wallet,
            req.body.optionIndex
         );
         sendSuccess(res, result, 200);
      } catch (error) {
         if (error instanceof GovernanceProposalNotFoundError) {
            sendNotFound(res, 'Proposal');
            return;
         }
         if (error instanceof VotingPeriodEndedError) {
            sendConflict(res, error.message);
            return;
         }
         if (error instanceof NoSnapshotVotingPowerError) {
            sendForbidden(res, error.message);
            return;
         }
         if (error instanceof DuplicateGovernanceVoteError) {
            sendConflict(res, error.message);
            return;
         }
         if (error instanceof InvalidVoteOptionError) {
            sendError(res, 422, ErrorCode.UNPROCESSABLE_ENTITY, error.message);
            return;
         }
         next(error);
      }
   }
);

export default router;

