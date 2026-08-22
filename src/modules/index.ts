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
import subscriptionRouter from './subscriptions/subscription.routes';
import webhookRouter from './webhooks/webhook.router';
import walletsRouter from './wallets/wallets.routes';
import alertsRouter from './alerts/alert.router';
import eventsRouter from './events/event.routes';
import { BASE as CREATORS_BASE } from '../constants/creator.constants';
import { routeBodySizeLimit } from '../middlewares/body-size-limit.middleware';

const router = Router();

// Each group gets its own JSON body parser so its size limit can be tuned
// independently via BODY_SIZE_LIMIT_<GROUP> env vars (see
// docs/body-size-limits.md). Groups without a dedicated override share
// BODY_SIZE_LIMIT_DEFAULT.
router.use('/health', routeBodySizeLimit('default'), healthRouter);
router.use('/auth', routeBodySizeLimit('auth'), authRouter);
router.use('/config', routeBodySizeLimit('default'), configRouter);
router.use(CREATORS_BASE, routeBodySizeLimit('creators'), creatorsRouter);
router.use(CREATORS_BASE, routeBodySizeLimit('creators'), creatorRouter);
router.use('/metrics', routeBodySizeLimit('default'), metricsRouter);
router.use('/ledger', routeBodySizeLimit('default'), ledgerRouter);
router.use('/admin', routeBodySizeLimit('admin'), adminRouter);
router.use('/activity', routeBodySizeLimit('default'), activityRouter);
router.use('/ownership', routeBodySizeLimit('default'), ownershipRouter);
router.use('/subscriptions', routeBodySizeLimit('default'), subscriptionRouter);
router.use(CREATORS_BASE, routeBodySizeLimit('creators'), webhookRouter);
router.use('/wallets', routeBodySizeLimit('default'), walletsRouter);
router.use('/alerts', routeBodySizeLimit('default'), alertsRouter);
router.use('/events', routeBodySizeLimit('default'), eventsRouter);

export default router;
