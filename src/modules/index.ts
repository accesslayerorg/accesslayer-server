import { routeBodySizeLimit } from '../middlewares/body-size-limit.middleware';
import { queryCostGovernor } from '../middlewares/query-cost-governor.middleware';
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
import tradingRouter from './trading/multi-buy.routes';
import sequencerRouter from './admin/sequencer.routes';
import keysRouter from './keys/keys.routes';
import notificationsRouter from './notifications/notification.routes';
import horizonWebhookRouter from './webhooks/horizon-webhook.routes';
import vestingRouter from './vesting/vesting.routes';
import investorRouter from './investor/investor.routes';
import followerRouter from './followers/follower.routes';
import { BASE as CREATORS_BASE } from '../constants/creator.constants';

const router = Router();

// Adaptive per-wallet/per-IP database query cost governor (#755). Mounted
// ahead of route resolution (so it matches on req.path, not req.route — see
// query-cost.utils.ts) and ahead of every group below, so it covers the
// whole API surface rather than needing to be threaded into each route
// individually. Exempts /health and its own /internal/qcost management
// routes (see QUERY_COST_EXEMPT_PATH_PREFIXES).
router.use(queryCostGovernor());

// Each group gets its own JSON body parser so its size limit can be tuned
// independently via BODY_SIZE_LIMIT_<GROUP> env vars (see
// docs/body-size-limits.md). Groups without a dedicated override share
// BODY_SIZE_LIMIT_DEFAULT.
router.use('/health', routeBodySizeLimit('default'), healthRouter);
router.use('/auth', routeBodySizeLimit('auth'), authRouter);
router.use('/config', routeBodySizeLimit('default'), configRouter);
router.use(CREATORS_BASE, routeBodySizeLimit('creators'), creatorsRouter);
router.use(CREATORS_BASE, routeBodySizeLimit('creators'), creatorRouter);
router.use('/creator', routeBodySizeLimit('creators'), creatorsRouter);
router.use('/creator', routeBodySizeLimit('creators'), creatorRouter);
router.use('/metrics', routeBodySizeLimit('default'), metricsRouter);
router.use('/ledger', routeBodySizeLimit('default'), ledgerRouter);
router.use('/admin', routeBodySizeLimit('admin'), adminRouter);
router.use('/activity', routeBodySizeLimit('default'), activityRouter);
router.use('/ownership', routeBodySizeLimit('default'), ownershipRouter);
router.use('/subscriptions', routeBodySizeLimit('default'), subscriptionRouter);
router.use(CREATORS_BASE, routeBodySizeLimit('creators'), webhookRouter);
router.use('/wallets', routeBodySizeLimit('default'), walletsRouter);
router.use('/alerts', routeBodySizeLimit('default'), alertsRouter);
router.use('/trading', routeBodySizeLimit('default'), tradingRouter);
router.use('/internal', routeBodySizeLimit('default'), sequencerRouter);
router.use('/keys', routeBodySizeLimit('default'), keysRouter);
router.use('/notifications', routeBodySizeLimit('default'), notificationsRouter);
router.use('/webhooks', routeBodySizeLimit('default'), horizonWebhookRouter);
router.use('/vesting', routeBodySizeLimit('default'), vestingRouter);
router.use('/investor', routeBodySizeLimit('default'), investorRouter);
router.use('/followers', routeBodySizeLimit('default'), followerRouter);

export default router;
