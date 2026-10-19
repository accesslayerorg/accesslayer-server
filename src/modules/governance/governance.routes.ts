import { Router } from 'express';
import { EscalatingProposalsQuerySchema } from './governance-escalation.schemas';
import { getEscalatingProposals } from './governance-escalation.service';
import {
   CastGovernanceVoteSchema,
   CreateGovernanceProposalSchema,
   ListGovernanceProposalsQuerySchema,
} from './governance-proposals.schemas';
import {
   castGovernanceVote,
   createGovernanceProposal,
   getGovernanceProposal,
   getGovernanceVotingWeight,
   getGovernanceWalletVote,
   DuplicateGovernanceVoteError,
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
import {
   validateSignedActionNonce,
   NonceAlreadyConsumedError,
   NonceMismatchError,
} from '../nonce';

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
 * GET /governance/proposals/:id/weight?wallet=...
 * Return the caller-selected wallet's frozen voting weight for a proposal.
 */
router.get('/proposals/:id/weight', async (req, res, next) => {
   const wallet = req.query.wallet;
   if (typeof wallet !== 'string' || wallet.trim().length === 0) {
      sendValidationError(res, 'Invalid query parameters', [
         { field: 'wallet', message: 'wallet is required' },
      ]);
      return;
   }

   try {
      const result = await getGovernanceVotingWeight(
         String(req.params.id),
         wallet.trim()
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
 * GET /governance/proposals/:proposal_id
 *
 * Single proposal detail with the full vote breakdown. `:proposal_id`
 * accepts the internal id or the on-chain proposalId. Status, tally, quorum,
 * and time remaining are computed from the stored on-chain state at request
 * time.
 */
router.get('/proposals/:proposal_id', async (req, res, next) => {
   try {
      const result = await getGovernanceProposal(
         String(req.params.proposal_id)
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
 * GET /governance/proposals/:proposal_id/votes/:wallet
 *
 * Returns the wallet's vote (option and weight) for the proposal together
 * with its frozen snapshot voting weight.
 */
router.get(
   '/proposals/:proposal_id/votes/:wallet',
   async (req, res, next) => {
      const wallet = String(req.params.wallet ?? '').trim();
      if (wallet.length === 0) {
         sendValidationError(res, 'Invalid path parameters', [
            { field: 'wallet', message: 'wallet is required' },
         ]);
         return;
      }

      try {
         const result = await getGovernanceWalletVote(
            String(req.params.proposal_id),
            wallet
         );
         sendSuccess(res, result);
      } catch (error) {
         if (error instanceof GovernanceProposalNotFoundError) {
            sendNotFound(res, 'Proposal');
            return;
         }
         next(error);
      }
   }
);

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
         const nonce =
            req.body.nonce ??
            (req.headers['x-nonce'] !== undefined
               ? Number(req.headers['x-nonce'])
               : undefined);
         if (nonce !== undefined) {
            await validateSignedActionNonce(
               req.user!.wallet,
               nonce,
               'governance:create_proposal'
            );
         }

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
         if (error instanceof NonceAlreadyConsumedError) {
            sendConflict(res, error.message);
            return;
         }
         if (error instanceof NonceMismatchError) {
            sendError(res, 400, ErrorCode.BAD_REQUEST, error.message);
            return;
         }
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
         const nonce =
            req.body.nonce ??
            (req.headers['x-nonce'] !== undefined
               ? Number(req.headers['x-nonce'])
               : undefined);
         if (nonce !== undefined) {
            await validateSignedActionNonce(
               req.user!.wallet,
               nonce,
               'governance:vote_proposal'
            );
         }

         const result = await castGovernanceVote(
            String(req.params.id),
            req.user!.wallet,
            req.body.optionIndex
         );
         sendSuccess(res, result, 200);
      } catch (error) {
         if (error instanceof NonceAlreadyConsumedError) {
            sendConflict(res, error.message);
            return;
         }
         if (error instanceof NonceMismatchError) {
            sendError(res, 400, ErrorCode.BAD_REQUEST, error.message);
            return;
         }
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
