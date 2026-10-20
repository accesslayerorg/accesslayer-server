import { Router } from 'express';
import { routeBodySizeLimit } from '../middlewares/body-size-limit.middleware';
import { queryCostGovernor } from '../middlewares/query-cost-governor.middleware';

import authRouter from './auth/auth.routes';
import healthRouter from './health/health.routes';
import statusRouter from './status/status.routes';
import configRouter from './config/config.routes';
import creatorsRouter from './creators/creators.routes';
import creatorRouter from './creator/creator.routes';
import metricsRouter from './metrics/metrics.routes';
import ledgerRouter from './ledger/ledger.routes';
import adminRouter from './admin/admin.routes';
import activityRouter from './activity/activity.routes';
import ownershipRouter from './ownership/ownership.routes';
import walRouter from './wal/wal.routes';
import { BASE as CREATORS_BASE } from '../constants/creator.constants';

const router = Router();

router.use('/health', healthRouter);
router.use('/auth', authRouter);
router.use('/config', configRouter);
router.use(CREATORS_BASE, creatorsRouter);
router.use('/metrics', metricsRouter);
router.use('/admin', adminRouter);
router.use('/activity', activityRouter);
router.use('/ownership', ownershipRouter);
router.use('/wal', walRouter);

export default router;
