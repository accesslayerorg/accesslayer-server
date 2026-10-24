// src/modules/multisig/multisig.routes.ts

import { Router } from 'express';
import {
   httpGetPendingActions,
   httpGetActionDetail,
   httpGetActionHistory,
} from './multisig-actions.controllers';

const router = Router();

router.get('/actions/pending', httpGetPendingActions);
router.get('/actions/history', httpGetActionHistory);
router.get('/actions/:actionId', httpGetActionDetail);
router.get('/actions/:action_id', httpGetActionDetail);

export default router;
