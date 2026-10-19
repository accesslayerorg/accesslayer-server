import { Router } from 'express';
import { sendSuccess, sendNotFound } from '../../utils/api-response.utils';
import {
   getPendingMultisigActions,
   getMultisigActionDetail,
   getMultisigActionHistory,
   ActionNotFoundError,
} from './multisig-actions.service';

const router = Router();

/**
 * GET /multisig/actions/pending
 * Returns list of pending multisig actions with signature count and threshold (#1085).
 */
router.get('/actions/pending', async (_req, res, next) => {
   try {
      const actions = await getPendingMultisigActions();
      sendSuccess(res, actions);
   } catch (error) {
      next(error);
   }
});

/**
 * GET /multisig/actions/history
 * Returns history of completed and expired multisig actions with outcomes (#1085).
 */
router.get('/actions/history', async (_req, res, next) => {
   try {
      const history = await getMultisigActionHistory();
      sendSuccess(res, history);
   } catch (error) {
      next(error);
   }
});

/**
 * GET /multisig/actions/:action_id
 * Returns single action detail with signer list and params (#1085).
 */
router.get('/actions/:action_id', async (req, res, next) => {
   try {
      const { action_id } = req.params;
      const detail = await getMultisigActionDetail(action_id);
      sendSuccess(res, detail);
   } catch (error) {
      if (error instanceof ActionNotFoundError) {
         return sendNotFound(res, 'Multisig action');
      }
      next(error);
   }
});

export default router;
