import { Router } from 'express';
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
   KeyPollNotFoundError,
} from './key-polls.service';

const router = Router();

const voteParamsSchema = StellarAddressSchema;

router.get('/:keyId/polls', async (req, res, next) => {
   try {
      const polls = await getKeyPolls(String(req.params.keyId));
      sendSuccess(res, polls);
   } catch (error) {
      if (error instanceof KeyPollNotFoundError) {
         sendNotFound(res, error.resource);
         return;
      }
      next(error);
   }
});

router.get('/:keyId/polls/:pollId', async (req, res, next) => {
   try {
      const poll = await getKeyPoll(
         String(req.params.keyId),
         String(req.params.pollId)
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
