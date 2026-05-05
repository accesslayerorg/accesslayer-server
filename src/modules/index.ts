import { Router } from 'express';
import authRouter from './auth/auth.routes';
import healthRouter from './health/health.routes';
import configRouter from './config/config.routes';
import creatorsRouter from './creators/creators.routes';
import metricsRouter from './metrics/metrics.routes';
import ledgerRouter from './ledger/ledger.routes';
import adminRouter from './admin/admin.routes';
import activityRouter from './activity/activity.routes';
import ownershipRouter from './ownership/ownership.routes';
import { BASE as CREATORS_BASE } from '../constants/creator.constants';

import { defaultBodyParser, adminBodyParser, creatorsBodyParser } from '../middlewares/body-parser.middleware';

const router = Router();

router.use('/health', defaultBodyParser, healthRouter);
router.use('/auth', defaultBodyParser, authRouter);
router.use('/config', defaultBodyParser, configRouter);
router.use(CREATORS_BASE, creatorsBodyParser, creatorsRouter);
router.use('/metrics', defaultBodyParser, metricsRouter);
router.use('/admin', adminBodyParser, adminRouter);
router.use('/activity', defaultBodyParser, activityRouter);
router.use('/ownership', defaultBodyParser, ownershipRouter);

export default router;
