import { Router } from 'express';
import authRouter from './auth/auth.routes';
import healthRouter from './health/health.routes';
import configRouter from './config/config.routes';
import creatorsRouter from './creators/creators.routes';
import creatorRouter from './creator/creator.routes';
import metricsRouter from './metrics/metrics.routes';
import ledgerRouter from './ledger/ledger.routes';
import adminRouter from './admin/admin.routes';
import activityRouter from './activity/activity.routes';
import ownershipRouter from './ownership/ownership.routes';
import analyticsRouter from './analytics/analytics.routes';
import referralsRouter from './referrals/referrals.routes';
import holdingsRouter from './holdings/holdings.routes';
import tradeRouter from './trade/trade.routes';
import webhooksRouter from './webhooks/webhooks.routes';
import { BASE as CREATORS_BASE } from '../constants/creator.constants';

const router = Router();

router.use('/health', healthRouter);
router.use('/auth', authRouter);
router.use('/config', configRouter);
router.use(CREATORS_BASE, creatorsRouter);
router.use(CREATORS_BASE, creatorRouter);
router.use('/metrics', metricsRouter);
router.use('/ledger', ledgerRouter);
router.use('/admin', adminRouter);
router.use('/activity', activityRouter);
router.use('/ownership', ownershipRouter);
router.use(analyticsRouter);
router.use(referralsRouter);
router.use(holdingsRouter);
router.use(tradeRouter);
router.use('/webhooks', webhooksRouter);

export default router;
