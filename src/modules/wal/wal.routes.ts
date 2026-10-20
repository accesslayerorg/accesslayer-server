import { Router } from 'express';
import { submitTrade, getWALEntry, triggerRecovery } from './wal.controllers';

const router = Router();

router.post('/submit', submitTrade);
router.get('/entry/:idOrTxHash', getWALEntry);
router.post('/recovery/trigger', triggerRecovery);

export default router;
