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
import subscriptionRouter from './subscriptions/subscription.routes';
import webhookRouter from './webhooks/webhook.router';
import walletsRouter from './wallets/wallets.routes';
import alertsRouter from './alerts/alert.router';
import invoiceRouter from './invoice/invoice.routes';
import freezeRouter from './freeze/freeze.routes';
import platformRouter from './platform/platform.routes';
import searchRouter from './search/search.routes';

import tradingRouter from './trading/multi-buy.routes';
import sequencerRouter from './admin/sequencer.routes';
import keysRouter from './keys/keys.routes';
import cooldownRouter from './keys/cooldown.routes';
import notificationsRouter from './notifications/notification.routes';
import horizonWebhookRouter from './webhooks/horizon-webhook.routes';
import vestingRouter from './vesting/vesting.routes';
import investorRouter from './investor/investor.routes';
import watchlistRouter from './investor/watchlist.routes';
import followerRouter from './followers/follower.routes';
import protocolRouter from './protocol/protocol.routes';
import revenueRouter from './revenue/revenue.routes';
import stakerRouter from './revenue/staker-revenue.routes';
import creatorRevenueRouter from './revenue/creator-revenue.routes';
import vaultRouter from './staking/vault.routes';
import portfolioRouter from './portfolio/portfolio.routes';
import referralRouter from './referrals/referral-earnings.routes';
import contractsRouter from './contracts/contract.routes';
import stakingRouter from './staking/staking.routes';
import sellersRouter from './sellers/sellers.routes';
import governanceRouter from './governance/governance.routes';
import factoryRouter from './factory/factory.routes';
import lpRouter from './lp/lp.routes';
import auctionRouter from './auctions/auction.routes';
import holdersRouter from './dividends/holders.routes';
import discoveryRouter from './keys/discovery.routes';
import tradesRouter from './trades/trades.routes';
import tradersRouter from './traders/traders.routes';
import nonceRouter from './nonce/nonce.routes';
import swapsRouter from './swaps/swaps.routes';

import { BASE as CREATORS_BASE } from '../constants/creator.constants';

const router = Router();

// Adaptive per-wallet/per-IP database query cost governor (#755).
// Mounted ahead of route resolution so it matches on req.path, not req.route,
// and ahead of every group below so it covers the whole API surface.
// Exempts /health and its own /internal/qcost management routes.
router.use(queryCostGovernor());

// Each group gets its own JSON body parser so its size limit can be tuned
// independently via BODY_SIZE_LIMIT_<GROUP> environment variables.
// Groups without a dedicated override share BODY_SIZE_LIMIT_DEFAULT.
router.use('/health', routeBodySizeLimit('default'), healthRouter);
router.use('/status', routeBodySizeLimit('default'), statusRouter);
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
router.use('/invoices', routeBodySizeLimit('default'), invoiceRouter);
router.use('/subscriptions', routeBodySizeLimit('default'), subscriptionRouter);
router.use(CREATORS_BASE, routeBodySizeLimit('creators'), webhookRouter);
router.use('/wallets', routeBodySizeLimit('default'), walletsRouter);
router.use('/alerts', routeBodySizeLimit('default'), alertsRouter);
router.use('/trading', routeBodySizeLimit('default'), tradingRouter);
router.use('/internal', routeBodySizeLimit('default'), sequencerRouter);

// Keys: mount keysRouter first, then freezeRouter so freeze handlers can
// handle /:keyId/freeze and /:keyId/unfreeze when needed.
router.use('/keys', routeBodySizeLimit('default'), keysRouter);
router.use('/keys', routeBodySizeLimit('default'), freezeRouter);
router.use('/cooldowns', routeBodySizeLimit('default'), cooldownRouter);

router.use(
  '/notifications',
  routeBodySizeLimit('default'),
  notificationsRouter
);
router.use('/webhooks', routeBodySizeLimit('default'), horizonWebhookRouter);
router.use('/vesting', routeBodySizeLimit('default'), vestingRouter);
router.use('/investor', routeBodySizeLimit('default'), investorRouter);
router.use('/followers', routeBodySizeLimit('default'), followerRouter);
router.use('/protocol', routeBodySizeLimit('default'), protocolRouter);
router.use('/platform', routeBodySizeLimit('default'), platformRouter);

// Global search across keys, creators and transaction hashes (#1010).
router.use('/search', routeBodySizeLimit('default'), searchRouter);
router.use('/revenue', routeBodySizeLimit('default'), revenueRouter);
router.use('/staker', routeBodySizeLimit('default'), stakerRouter);
router.use('/', routeBodySizeLimit('default'), creatorRevenueRouter);
router.use('/staking', routeBodySizeLimit('default'), vaultRouter);
router.use('/portfolio', routeBodySizeLimit('default'), portfolioRouter);
router.use('/referrals', routeBodySizeLimit('default'), referralRouter);
router.use('/contracts', routeBodySizeLimit('default'), contractsRouter);
router.use('/watchlist', routeBodySizeLimit('default'), watchlistRouter);
router.use(
  '/investor/watchlist',
  routeBodySizeLimit('default'),
  watchlistRouter
);
router.use('/staking', routeBodySizeLimit('default'), stakingRouter);
router.use('/sellers', routeBodySizeLimit('default'), sellersRouter);
router.use('/governance', routeBodySizeLimit('default'), governanceRouter);
router.use('/factory', routeBodySizeLimit('default'), factoryRouter);
router.use('/lp', routeBodySizeLimit('default'), lpRouter);
router.use('/auctions', routeBodySizeLimit('default'), auctionRouter);
router.use('/holders', routeBodySizeLimit('default'), holdersRouter);

router.use('/discovery', routeBodySizeLimit('default'), discoveryRouter);
router.use('/trades', routeBodySizeLimit('default'), tradesRouter);
router.use('/traders', routeBodySizeLimit('default'), tradersRouter);
router.use('/nonce', routeBodySizeLimit('default'), nonceRouter);
router.use('/swaps', routeBodySizeLimit('default'), swapsRouter);

export default router;