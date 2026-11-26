import campaignsRouter from './campaigns/campaigns.routes';
import { protocolPolRouter, keyBackstopsRouter } from './pol/pol.routes';
import scheduledTransferRouter from './scheduled-transfers/scheduled-transfer.routes';
import marketplaceRouter from './marketplaces/marketplace.routes';
import royaltyEnforcementRouter from './marketplaces/royalty-enforcement.routes';
import concentrationRouter from './concentration/concentration.routes';
import keyLpRewardsRouter from './lp-rewards/lp-rewards.routes';
import errorCatalogRouter from './error-catalog/error-catalog.routes';
import accountRouter from './account/account.routes';
import tradeNotesRouter from './trade-notes/trade-notes.routes';
import {
   disclosuresAdminRouter,
   disclosuresRouter,
} from './disclosures/disclosures.routes';
import { supportAttachmentUploadRouter, supportRouter } from './support/support.routes';
import { supportAgentRouter } from './support/support-agent.routes';
import {
   creatorVerificationAdminRouter,
   creatorVerificationRouter,
} from './creator-verification/creator-verification.routes';
import { screenerRouter, screensRouter } from './screener/screener.routes';
import pushRouter from './push/push.routes';
import embeddedWalletRouter from './auth/embedded-wallet.routes';
import {
   keyRoadmapRouter,
   milestoneReactionsRouter,
} from './roadmap/roadmap.routes';
import { keyQaRouter, qaRouter } from './qa/qa.routes';
import { embedRouter, embedCreatorRouter } from './embed/embed.routes';
import {
   broadcastCreatorRouter,
   broadcastMeRouter,
   broadcastPublicRouter,
} from './broadcast/broadcast.routes';
import { airdropAdminRouter, airdropRouter } from './airdrops/airdrop.routes';
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
import {
   socialRecoveryRouter,
   guardianRequestsRouter,
} from './wallets/social-recovery.routes';
import alertsRouter from './alerts/alert.router';
import analyticsRouter from './analytics/analytics.routes';
import {
   tokenRescueAdminRouter,
   tokenRescuePublicRouter,
} from './token-rescue/token-rescue.routes';
import {
   protocolEscapeRouter,
   walletEscapeRouter,
} from './protocol/protocol-escape.routes';
import invoiceRouter from './invoice/invoice.routes';
import { issuerRouter } from './invoice/invoice-protocol.routes';
import freezeRouter from './freeze/freeze.routes';
import platformRouter from './platform/platform.routes';
import searchRouter from './search/search.routes';
import { issuerVerificationRouter } from './issuers/issuer-verification.routes';
import { investorHealthRouter } from './portfolio/portfolio-health-score.routes';

import tradingRouter from './trading/multi-buy.routes';
import sequencerRouter from './admin/sequencer.routes';
import keysRouter from './keys/keys.routes';
import activityHeatmapRouter from './keys/activity-heatmap.routes';
import commitRevealLaunchRouter from './keys/commit-reveal-launch.routes';
import launchesRouter from './keys/launches.routes';
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
import referralTierRouter from './referrals/referral-tier.routes';
import referralRouter from './referrals/referrals.routes';
import referralEarningsRouter from './referrals/referral-earnings.routes';
import {
   ambassadorRouter,
   referralClickRouter,
} from './ambassador/ambassador.routes';
import contractsRouter from './contracts/contract.routes';
import stakingRouter from './staking/staking.routes';
import { stakingEpochRouter, keyEpochRouter } from './staking/staking-epoch.routes';
import sellersRouter from './sellers/sellers.routes';
import governanceRouter from './governance/governance.routes';
import factoryRouter from './factory/factory.routes';
import lpRouter from './lp/lp.routes';
import auctionRouter from './auctions/auction.routes';
import dutchAuctionRouter from './dutch-auctions/dutch-auction.routes';
import ordersRouter from './orders/order.routes';
import escrowOrderRouter from './orders/escrow-order.routes';
import triggerRouter from './orders/trigger-group.routes';
import holdersRouter from './dividends/holders.routes';
import multisigRouter from './multisig/multisig.routes';
import discoveryRouter from './keys/discovery.routes';
import tradesRouter from './trades/trades.routes';
import tradersRouter from './traders/traders.routes';
import nonceRouter from './nonce/nonce.routes';
import swapsRouter from './swaps/swaps.routes';
import announcementsRouter from './announcements/announcements.routes';
import eventsRouter from './events/events.routes';
import {
   keyPassEventsRouter,
   passEventsRouter,
} from './pass-events/pass-events.routes';
import tipsRouter from './tips/tips.routes';
import { flagRouter } from './flags/feature-flags.routes';
import commentsRouter from './comments/comments.routes';
import { commentsModerationRouter } from './comments/comments.routes';
import { adminReportsRouter } from './reports/key-reports.routes';
import { BASE as CREATORS_BASE } from '../constants/creator.constants';
import { relatedKeysRouter } from '../routes/keys.routes';
import { paymentAssetsRouter, quotesRouter } from './payments/payment-assets.routes';
import { bountiesRouter, creatorBountiesRouter } from './bounties/bounty.routes';
import { dcaRouter } from './dca/dca.routes';

const router = Router();

// Adaptive per-wallet/per-IP database query cost governor (#755).
// Mounted ahead of route resolution (so it matches on req.path, not req.route — see
// query-cost.utils.ts) and ahead of every group below, so it covers the whole API
// surface rather than needing to be threaded into each route individually.
// Exempts /health and its own /internal/qcost management routes (see
// QUERY_COST_EXEMPT_PATH_PREFIXES).
router.use(queryCostGovernor());

// Each group gets its own JSON body parser so its size limit can be tuned
// independently via BODY_SIZE_LIMIT_<GROUP> environment variables.
// Groups without a dedicated override share BODY_SIZE_LIMIT_DEFAULT.
router.use('/health', routeBodySizeLimit('default'), healthRouter);
router.use('/status', routeBodySizeLimit('default'), statusRouter);
router.use('/auth', routeBodySizeLimit('auth'), authRouter);
router.use('/config', routeBodySizeLimit('default'), configRouter);
// Creator verification routes (#1324). Mounted ahead of creatorsRouter so
// /creators/me/verification is not captured by the /:id routes there.
router.use(CREATORS_BASE, routeBodySizeLimit('creators'), creatorBountiesRouter);
router.use(CREATORS_BASE, routeBodySizeLimit('creators'), creatorVerificationRouter);
router.use(CREATORS_BASE, routeBodySizeLimit('creators'), creatorsRouter);
router.use(CREATORS_BASE, routeBodySizeLimit('creators'), creatorRouter);
router.use('/creator', routeBodySizeLimit('creators'), creatorsRouter);
router.use('/creator', routeBodySizeLimit('creators'), creatorRouter);
router.use('/metrics', routeBodySizeLimit('default'), metricsRouter);
router.use('/ledger', routeBodySizeLimit('default'), ledgerRouter);
// Moderator key report queue (#1226). Mounted ahead of adminRouter: these
// routes use wallet-based moderator auth rather than the admin JWT guard.
router.use(
   '/admin/reports',
   routeBodySizeLimit('admin'),
   adminReportsRouter
);
// Support agent routes (#1327), guarded by the admin JWT per route.
router.use('/admin/support', routeBodySizeLimit('admin'), supportAgentRouter);
// Creator verification review queue (#1324), guarded by the admin JWT per route.
router.use('/admin/verification', routeBodySizeLimit('admin'), creatorVerificationAdminRouter);
// Attachment uploads take raw bytes, so this router is mounted without the
// JSON parser that the rest of /support uses (#1327).
router.use('/support', supportAttachmentUploadRouter);
router.use('/admin', routeBodySizeLimit('admin'), tokenRescueAdminRouter);
router.use('/admin', routeBodySizeLimit('admin'), adminRouter);
router.use('/transparency', routeBodySizeLimit('default'), tokenRescuePublicRouter);
router.use('/activity', routeBodySizeLimit('default'), activityRouter);
router.use('/ownership', routeBodySizeLimit('default'), ownershipRouter);
router.use('/invoices', routeBodySizeLimit('default'), invoiceRouter);
router.use('/issuers', routeBodySizeLimit('default'), issuerRouter);
router.use('/issuers', routeBodySizeLimit('default'), issuerVerificationRouter);
router.use('/investors', routeBodySizeLimit('default'), investorHealthRouter);
router.use('/subscriptions', routeBodySizeLimit('default'), subscriptionRouter);
router.use(CREATORS_BASE, routeBodySizeLimit('creators'), webhookRouter);
router.use('/wallets', routeBodySizeLimit('default'), walletEscapeRouter);
router.use('/wallets', routeBodySizeLimit('default'), walletsRouter);
// #1350: social recovery guardian config + pending recovery view.
router.use('/wallets', routeBodySizeLimit('default'), socialRecoveryRouter);
router.use('/guardians', routeBodySizeLimit('default'), guardianRequestsRouter);
router.use('/alerts', routeBodySizeLimit('default'), alertsRouter);
router.use('/analytics', routeBodySizeLimit('default'), analyticsRouter);
router.use('/trading', routeBodySizeLimit('default'), tradingRouter);
router.use('/internal', routeBodySizeLimit('default'), sequencerRouter);
router.use('/keys', routeBodySizeLimit('default'), relatedKeysRouter);

// Keys: existing keysRouter first, then freezeRouter so /:keyId/freeze and
// /:keyId/unfreeze fall through to freeze handlers if keysRouter doesn't own
// them. Both share the same body-size group.
router.use('/keys', routeBodySizeLimit('default'), keysRouter);
router.use('/keys', routeBodySizeLimit('default'), activityHeatmapRouter);
router.use('/keys', routeBodySizeLimit('default'), commitRevealLaunchRouter);
router.use('/keys', routeBodySizeLimit('default'), keyPassEventsRouter);
router.use('/launches', routeBodySizeLimit('default'), launchesRouter);
router.use('/keys', routeBodySizeLimit('default'), freezeRouter);
router.use('/keys', routeBodySizeLimit('default'), commentsRouter);
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
router.use('/protocol', routeBodySizeLimit('default'), protocolEscapeRouter);
router.use('/protocol', routeBodySizeLimit('default'), protocolRouter);
router.use('/platform', routeBodySizeLimit('default'), platformRouter);

// Global search across keys, creators and transaction hashes (#1010).
router.use('/search', routeBodySizeLimit('default'), searchRouter);
router.use('/revenue', routeBodySizeLimit('default'), revenueRouter);
router.use('/staker', routeBodySizeLimit('default'), stakerRouter);
router.use('/', routeBodySizeLimit('default'), creatorRevenueRouter);
router.use('/staking', routeBodySizeLimit('default'), vaultRouter);
router.use('/portfolio', routeBodySizeLimit('default'), portfolioRouter);
router.use('/referrals', routeBodySizeLimit('default'), referralTierRouter);
router.use('/referrals', routeBodySizeLimit('default'), referralRouter);
router.use('/referrals', routeBodySizeLimit('default'), referralEarningsRouter);
router.use('/referrals', routeBodySizeLimit('default'), referralClickRouter);
router.use('/ambassador', routeBodySizeLimit('default'), ambassadorRouter);
router.use('/contracts', routeBodySizeLimit('default'), contractsRouter);
router.use('/watchlist', routeBodySizeLimit('default'), watchlistRouter);
router.use(
   '/investor/watchlist',
   routeBodySizeLimit('default'),
   watchlistRouter
);
router.use('/staking', routeBodySizeLimit('default'), stakingRouter);
router.use('/staking', routeBodySizeLimit('default'), stakingEpochRouter);
router.use('/keys', routeBodySizeLimit('default'), keyEpochRouter);
router.use('/sellers', routeBodySizeLimit('default'), sellersRouter);
router.use('/governance', routeBodySizeLimit('default'), governanceRouter);
router.use('/factory', routeBodySizeLimit('default'), factoryRouter);
router.use('/lp', routeBodySizeLimit('default'), lpRouter);
router.use('/auctions', routeBodySizeLimit('default'), auctionRouter);
router.use('/auctions', dutchAuctionRouter);
router.use('/holders', routeBodySizeLimit('default'), holdersRouter);
router.use('/orders', routeBodySizeLimit('default'), ordersRouter);
// #1351: limit order escrow — indexed on-chain order state + keeper stats.
router.use('/orders', routeBodySizeLimit('default'), escrowOrderRouter);
// #1352: linked take-profit / stop-loss triggers (OCO).
router.use('/triggers', routeBodySizeLimit('default'), triggerRouter);
router.use('/multisig', routeBodySizeLimit('default'), multisigRouter);
router.use('/events', routeBodySizeLimit('default'), eventsRouter);
router.use('/events', routeBodySizeLimit('default'), passEventsRouter);
router.use('/tips', routeBodySizeLimit('default'), tipsRouter);
router.use('/comments', routeBodySizeLimit('default'), commentsModerationRouter);
router.use('/discovery', routeBodySizeLimit('default'), discoveryRouter);
router.use('/trades', routeBodySizeLimit('default'), tradesRouter);
router.use('/traders', routeBodySizeLimit('default'), tradersRouter);
router.use('/nonce', routeBodySizeLimit('default'), nonceRouter);
router.use('/swaps', routeBodySizeLimit('default'), swapsRouter);
router.use('/announcements', routeBodySizeLimit('default'), announcementsRouter);
router.use('/flags', routeBodySizeLimit('default'), flagRouter);

router.use('/campaigns', routeBodySizeLimit('default'), campaignsRouter);
router.use('/protocol', routeBodySizeLimit('default'), protocolPolRouter);
router.use('/keys', routeBodySizeLimit('default'), keyBackstopsRouter);
router.use('/wallets', routeBodySizeLimit('default'), scheduledTransferRouter);
router.use('/marketplaces', routeBodySizeLimit('default'), marketplaceRouter);
router.use('/keys', routeBodySizeLimit('default'), royaltyEnforcementRouter);
router.use('/keys', routeBodySizeLimit('default'), concentrationRouter);
router.use('/keys', routeBodySizeLimit('default'), keyLpRewardsRouter);
router.use('/admin/airdrops', routeBodySizeLimit('admin'), airdropAdminRouter);
router.use('/airdrops', routeBodySizeLimit('default'), airdropRouter);

// Contract error catalog and decoding helper (#1326).
router.use('/errors', routeBodySizeLimit('default'), errorCatalogRouter);

// Personal data export and account deletion for the signed-in user (#1325).
router.use('/me', routeBodySizeLimit('default'), accountRouter);

// Private trade journal notes (#1315).
router.use('/me', routeBodySizeLimit('default'), tradeNotesRouter);

// Risk disclosure acknowledgements (#1318).
router.use('/disclosures', routeBodySizeLimit('default'), disclosuresRouter);
router.use('/admin/disclosures', routeBodySizeLimit('admin'), disclosuresAdminRouter);

// User support tickets (#1327).
router.use('/support', routeBodySizeLimit('default'), supportRouter);

// Key screener & saved screens (#1312).
router.use('/screener', routeBodySizeLimit('default'), screenerRouter);
router.use('/screens', routeBodySizeLimit('default'), screensRouter);

// Web push subscriptions & VAPID key (#1314).
router.use('/push', routeBodySizeLimit('default'), pushRouter);

// Embedded wallet signing & export (#1313).
router.use('/embedded-wallet', routeBodySizeLimit('auth'), embeddedWalletRouter);

// Creator roadmap & holder reactions (#1310).
router.use('/keys', routeBodySizeLimit('default'), keyRoadmapRouter);
router.use('/milestones', routeBodySizeLimit('default'), milestoneReactionsRouter);

// Holder Q&A sessions (#1311).
router.use('/keys', routeBodySizeLimit('default'), keyQaRouter);
router.use('/qa', routeBodySizeLimit('default'), qaRouter);
// Multi-asset payment registry & conversion quotes (#1309).
router.use('/payment-assets', routeBodySizeLimit('default'), paymentAssetsRouter);
router.use('/quotes', routeBodySizeLimit('default'), quotesRouter);

// Bounty board (#1307).
router.use('/bounties', routeBodySizeLimit('default'), bountiesRouter);

// Recurring purchase (DCA) plans (#1322).
router.use('/dca', routeBodySizeLimit('default'), dcaRouter);
// Embeddable SVG badge, widget & creator embed settings (#1320).
router.use('/embed', routeBodySizeLimit('default'), embedRouter);
router.use(CREATORS_BASE, routeBodySizeLimit('creators'), embedCreatorRouter);

// Consented creator email broadcast pipeline (#1319).
router.use('/me', routeBodySizeLimit('default'), broadcastMeRouter);
router.use('/broadcasts', routeBodySizeLimit('default'), broadcastPublicRouter);
router.use(CREATORS_BASE, routeBodySizeLimit('creators'), broadcastCreatorRouter);

export default router;
