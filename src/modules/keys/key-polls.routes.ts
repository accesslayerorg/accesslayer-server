import { Router } from 'express';
import { z } from 'zod';
import {
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { StellarAddressSchema } from '../wallet/wallet.schemas';
import {
   getKeyPoll,
   getKeyPollVote,
   getKeyPolls,
   InvalidKeyPollCursorError,
   KEY_POLLS_DEFAULT_LIMIT,
   KEY_POLLS_MAX_LIMIT,
   KeyPollNotFoundError,
} from './key-polls.service';

const router = Router();

const voteParamsSchema = StellarAddressSchema;

const pollListQuerySchema = z.object({
   status: z.enum(['active', 'closed', 'all']).optional().default('all'),
   cursor: z.string().min(1).max(128).optional(),
   limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(KEY_POLLS_MAX_LIMIT)
      .optional()
      .default(KEY_POLLS_DEFAULT_LIMIT),
});

const pollDetailQuerySchema = z.object({
   wallet: StellarAddressSchema.optional(),
});

/**
 * GET /keys/:keyId/polls?status=active|closed|all&cursor=&limit=
 * Paginated polls with tally and time remaining. Responds with
 * `{ items, nextCursor }`; pass `nextCursor` back as `cursor` for the next page.
 */
router.get('/:keyId/polls', async (req, res, next) => {
   const parsed = pollListQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const page = await getKeyPolls(String(req.params.keyId), {
         status: parsed.data.status,
         cursor: parsed.data.cursor,
         limit: parsed.data.limit,
      });
      sendSuccess(res, page);
   } catch (error) {
      if (error instanceof KeyPollNotFoundError) {
         sendNotFound(res, error.resource);
         return;
      }
      if (error instanceof InvalidKeyPollCursorError) {
         sendValidationError(res, 'Invalid cursor', [
            {
               field: 'cursor',
               message: 'Cursor does not match a poll for this key',
            },
         ]);
         return;
      }
      next(error);
   }
});

/**
 * GET /keys/:keyId/polls/:pollId?wallet=G...
 * Poll detail with per-option results. With `wallet`, includes `walletVote`.
 */
router.get('/:keyId/polls/:pollId', async (req, res, next) => {
   const parsed = pollDetailQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const poll = await getKeyPoll(
         String(req.params.keyId),
         String(req.params.pollId),
         parsed.data.wallet
      );
      sendSuccess(res, poll);
   } catch (error) {
      if (error instanceof KeyPollNotFoundError) {
         sendNotFound(res, error.resource);
         return;
      }
      next(error);
   }
});

router.get('/:keyId/polls/:pollId/votes/:wallet', async (req, res, next) => {
   const parsed = voteParamsSchema.safeParse(req.params.wallet);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid wallet address',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const result = await getKeyPollVote(
         String(req.params.keyId),
         String(req.params.pollId),
         parsed.data
      );
      sendSuccess(res, result);
   } catch (error) {
      if (error instanceof KeyPollNotFoundError) {
         sendNotFound(res, error.resource);
         return;
      }
      next(error);
   }
});

export default router;
