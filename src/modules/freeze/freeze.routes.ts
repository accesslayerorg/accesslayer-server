import { Router } from 'express';
import { adminGuard } from '../../middlewares/admin-guard.middleware';
import { httpGetFreezeStatus, httpEmergencyFreeze, httpInitiateUnfreeze } from './freeze.controllers';

const router = Router();
router.get('/:keyId/freeze', httpGetFreezeStatus);
router.post('/:keyId/freeze', adminGuard, httpEmergencyFreeze);
router.post('/:keyId/unfreeze', adminGuard, httpInitiateUnfreeze);
export default router;
