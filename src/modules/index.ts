import { Router } from 'express';
import authRouter from './auth/auth.routes';
import healthRouter from './health/health.routes';
import configRouter from './config/config.routes';
import creatorsRouter from './creators/creators.routes';
import metricsRouter from './metrics/metrics.routes';
import adminRouter from './admin/admin.routes';
import activityRouter from './activity/activity.routes';
import ownershipRouter from './ownership/ownership.routes';
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

export default router;
