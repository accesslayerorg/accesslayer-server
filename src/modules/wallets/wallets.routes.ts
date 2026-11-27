import { Router } from "express";
import { httpGetWalletActivity } from "./wallet-activity.controllers";
import { httpGetWalletHoldings } from "./wallet-holdings.controllers";
import { httpGetWalletFollowing } from "./wallet-following.controllers";
import { httpGetWalletVaultHealth } from "./wallet-vault-health.controllers";
import {
   httpGetWalletGains,
   httpGetWalletGainsCsv,
} from "./wallet-gains.controllers";
import { httpGetWalletReferrals } from "../referrals/referrals.controller";
import {
   httpGetWalletBalanceHistory,
   httpGetWalletPortfolioAsOf,
} from "./balance-history.controllers";
import { httpGetWalletPerformance } from "./wallet-performance.controllers";
import { cacheControl } from "../../middlewares/cache-control.middleware";
import { ACTIVITY_FEED_CACHE_PRESET } from "../../constants/activity-feed-cache.constants";
import { requireWalletParamMatch } from "../../middlewares/jwt-auth.middleware";
import { jwtAuth } from "../../middlewares/jwt.middleware";

const walletsRouter = Router();

/**
 * GET /api/v1/wallets/:address/activity
 *
 * Returns the unified chronological on-chain activity feed for a wallet
 * across buys, sells, transfers, burns, and dividends.
 * Requires a valid JWT matching the address parameter.
 */
walletsRouter.get(
   "/:address/activity",
   requireWalletParamMatch("address"),
   cacheControl(ACTIVITY_FEED_CACHE_PRESET),
   httpGetWalletActivity
);

/**
 * GET /api/v1/wallets/:address/holdings
 *
 * Returns all creator key holdings for a given Stellar wallet address.
 */
walletsRouter.get("/:address/holdings", httpGetWalletHoldings);

/**
 * GET /api/v1/wallets/:address/vault/health
 *
 * Returns the health factor and liquidation price for the wallet's open
 * lending-vault position. 404 when the wallet has no open position.
 */
walletsRouter.get("/:address/vault/health", httpGetWalletVaultHealth);

/**
 * GET /api/v1/wallets/:address/gains?year=YYYY
 *
 * Realized gains per sell (average-cost accounting) for the given UTC year,
 * with totals. Returns an empty rows array and zero totals when the wallet
 * has no sells in that year.
 */
walletsRouter.get("/:address/gains", httpGetWalletGains);

/**
 * GET /api/v1/wallets/:address/gains.csv?year=YYYY
 *
 * Same data as /gains, streamed as a CSV attachment with columns
 * date, key, quantity, proceeds, cost_basis, gain.
 */
walletsRouter.get("/:address/gains.csv", httpGetWalletGainsCsv);

/**
 * GET /api/v1/wallets/:address/following
 *
 * Returns all creators that the given wallet follows, ordered
 * alphabetically by display name. Requires JWT authentication.
 */
walletsRouter.get('/:address/following', jwtAuth, httpGetWalletFollowing);

/**
 * GET /api/v1/wallets/:address/referrals
 *
 * Returns referral statistics for a wallet: referral count, tier, total earned,
 * and pending claim. Public endpoint, no authentication required.
 */
walletsRouter.get('/:address/referrals', httpGetWalletReferrals);

/**
 * GET /v1/wallets/:address/balance-history?keyId=&from=&to=
 *
 * Returns step points of checkpointed balances between ledgers (#1323).
 */
walletsRouter.get('/:address/balance-history', httpGetWalletBalanceHistory);

/**
 * GET /v1/wallets/:address/portfolio?asOf=<ISO date>
 *
 * Returns a wallet's holdings as of an ISO timestamp, including the
 * resolved ledger and approximation flag (#1323).
 */
walletsRouter.get('/:address/portfolio', httpGetWalletPortfolioAsOf);

/**
 * GET /v1/wallets/:address/performance?range=
 *
 * Returns time-weighted portfolio performance, normalized benchmark series,
 * and summary return differences (#1321).
 */
walletsRouter.get('/:address/performance', httpGetWalletPerformance);

export default walletsRouter;
