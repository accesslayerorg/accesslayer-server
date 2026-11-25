import { queryCostGovernor } from './middlewares/query-cost-governor.middleware';
import campaignsRouter from './modules/campaigns/campaigns.routes';
import { protocolPolRouter, keyBackstopsRouter } from './modules/pol/pol.routes';
import scheduledTransferRouter from './modules/scheduled-transfers/scheduled-transfer.routes';
import marketplaceRouter from './modules/marketplaces/marketplace.routes';
import royaltyEnforcementRouter from './modules/marketplaces/royalty-enforcement.routes';
import concentrationRouter from './modules/concentration/concentration.routes';
import { airdropAdminRouter, airdropRouter } from './modules/airdrops/airdrop.routes';
// src/app.ts
import express, { Express, Response, RequestHandler } from 'express';
import { TspecDocsMiddleware } from 'tspec';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware'; // Add notFoundHandler import
import router from './modules/index';
import stakingRouter from './modules/staking/staking.routes';
import statusRouter from './modules/status/status.routes';
import keysRouter from './modules/keys/keys.routes';
import tradesRouter from './modules/trades/trades.routes';
import tradersRouter from './modules/traders/traders.routes';
import nonceRouter from './modules/nonce/nonce.routes';
import swapsRouter from './modules/swaps/swaps.routes';
import milestonesRouter from './modules/keys/milestones.routes';
import internalRouter from './modules/admin/sequencer.routes';
import eventsRouter from './modules/events/events.routes';
import announcementsRouter from './modules/announcements/announcements.routes';
import ratesRouter from './routes/rates.routes';
import { corsMiddleware } from './middlewares/cors.middleware';
import helmet from 'helmet';
import morgan from 'morgan';
import shareRouter from './modules/share/share.routes';
import sitemapRouter from './modules/sitemap/sitemap.routes';
import tspecOptions from './tspec.config';
import { createDocsRouter } from './docs/docs.routes';
import { SendMail } from './utils/mail.utils';
import { appRateLimit } from './middlewares/rate.middleware';
import { requestIdMiddleware } from './middlewares/request-id.middleware';
import { responseTimingMiddleware } from './middlewares/response-timing.middleware';
import { apiVersionMiddleware } from './middlewares/api-version.middleware';
import { schemaVersionMiddleware } from './middlewares/schema-version.middleware';
import { requestLoggerMiddleware } from './middlewares/request-logger.middleware';
import { requestContextMiddleware } from './middlewares/request-context.middleware';
import { requestEntryLoggerMiddleware } from './middlewares/request-entry-logger.middleware';
import {
   requestCompletionLoggerMiddleware,
   slowRequestLoggerMiddleware,
} from './middlewares/request-completion-logger.middleware';
import { sessionActivityMiddleware } from './middlewares/session-activity.middleware';
import { bodyParseErrorMiddleware } from './middlewares/body-parse-error.middleware';
import { routeBodySizeLimit } from './middlewares/body-size-limit.middleware';
import { envConfig } from './config';
import { v1RelatedKeysRouter } from './routes/keys.routes';
import { logger } from './utils/logger.utils';
import { sanctionedAddressMiddleware } from './middlewares/sanctioned-address.middleware';
import { impersonationGuard } from './middlewares/impersonation-guard.middleware';
import {
   responseCachePolicyMiddleware,
   responseCompressionMiddleware,
} from './middlewares/response-representation.middleware';

const app: Express = express();

// Middleware setup
app.set('trust proxy', 1);
app.use(responseTimingMiddleware);
// requestIdMiddleware must run before requestContextMiddleware: it assigns
// req.traceId/req.requestId, which requestContextMiddleware then captures
// into AsyncLocalStorage for the rest of the request's call stack.
app.use(requestIdMiddleware);
app.use(requestContextMiddleware);
app.use(apiVersionMiddleware);
app.use(schemaVersionMiddleware);
app.use(requestEntryLoggerMiddleware);
app.use(requestCompletionLoggerMiddleware);
app.use(slowRequestLoggerMiddleware);
// Session activity logging (#1035): registers a res.on('finish') listener
// so it can read req.user after route-level auth guards have run. Mount
// position only needs to be before the routers.
app.use(sessionActivityMiddleware);
app.use(corsMiddleware());
app.use(helmet());

// Request body parsing is applied per route group (see modules/index.ts)
// via routeBodySizeLimit, so each group can have its own configured size
// limit instead of one global express.json() call. bodyParseErrorMiddleware
// is mounted after the router (below) since that's where those parsers
// actually live now — Express only walks forward to later error handlers,
// so it has to come after the point where the parse error can occur.

if (!envConfig.ENABLE_REQUEST_LOGGING) {
   app.use(morgan('combined'));
}

app.use(requestLoggerMiddleware);
app.use(express.urlencoded({ extended: true }));
app.use(appRateLimit);
app.use(sanctionedAddressMiddleware);
// Read-only impersonation enforcement (#1342). Must run before every router
// so an impersonation token can never reach a write or sensitive route.
app.use(impersonationGuard);
// Response representation (#1343): cache-control defaults for authenticated
// traffic, then gzip/brotli for compressible bodies. Both wrap res.send, so
// they cover res.json too. Express's built-in ETag and 304 handling sits on
// top of the final bytes.
app.use(responseCachePolicyMiddleware);
app.use(responseCompressionMiddleware);

// Health check endpoints are now in /api/v1/health

async function setupTspecDocs() {
   try {
      const tspecMiddlewares = await TspecDocsMiddleware(tspecOptions);
      app.use(
         '/api-docs',
         ...(tspecMiddlewares as unknown as RequestHandler[])
      );
   } catch (error) {
      logger.error({ error }, 'Failed to setup API docs');
   }
}

setupTspecDocs();

// Quick test endpoint
app.get('/test-email', async (_, res: Response) => {
   try {
      const result = await SendMail({
         to: 'aniokesebastian@gmail.com',
         subject: 'Test Email',
         html: '<h1>Test</h1><p>If you get this, it works!</p>',
      });

      res.json({
         success: result,
         message: result ? 'Check your email' : 'Email failed',
      });
   } catch (error) {
      res.json({ error: error });
   }
});

// Redirect root
app.get('/', (_, res: Response) => {
   res.redirect('/api-docs');
});

// Routes
app.use('/v1', v1RelatedKeysRouter);
app.use('/status', routeBodySizeLimit('default'), statusRouter);
app.use('/nonce', routeBodySizeLimit('default'), nonceRouter);
app.use('/internal', routeBodySizeLimit('default'), internalRouter);
// OpenAPI spec + Swagger UI (#1224). Registered before the main router.
app.use('/api/v1', createDocsRouter());

// XLM fiat rate proxy (#1219). Mounted at both the documented path
// (/v1/rates) and the versioned API prefix used by every other route.
app.use('/v1/rates', ratesRouter);
app.use('/api/v1/rates', ratesRouter);
app.use('/v1', router);
app.use('/api/v1', router);
app.use('/announcements', routeBodySizeLimit('default'), announcementsRouter);
app.use('/v1', queryCostGovernor());
app.use('/v1/protocol', routeBodySizeLimit('default'), protocolPolRouter);
app.use('/v1/keys', routeBodySizeLimit('default'), keyBackstopsRouter);
app.use('/campaigns', queryCostGovernor(), routeBodySizeLimit('default'), campaignsRouter);
app.use('/v1/wallets', routeBodySizeLimit('default'), scheduledTransferRouter);
app.use('/v1/marketplaces', routeBodySizeLimit('default'), marketplaceRouter);
app.use('/v1/keys', routeBodySizeLimit('default'), royaltyEnforcementRouter);
app.use('/v1/keys', routeBodySizeLimit('default'), concentrationRouter);
app.use('/v1/admin/airdrops', routeBodySizeLimit('admin'), airdropAdminRouter);
app.use('/v1/airdrops', routeBodySizeLimit('default'), airdropRouter);
app.use('/staking', routeBodySizeLimit('default'), stakingRouter);
app.use('/trades', routeBodySizeLimit('default'), tradesRouter);
app.use('/traders', routeBodySizeLimit('default'), tradersRouter);
app.use('/keys', routeBodySizeLimit('default'), keysRouter);
app.use('/milestones', routeBodySizeLimit('default'), milestonesRouter);
app.use('/swaps', routeBodySizeLimit('default'), swapsRouter);
app.use('/events', routeBodySizeLimit('default'), eventsRouter);
app.use('/share', shareRouter);
app.use(sitemapRouter);

// Catches body-parse errors (including entity.too.large from the per-group
// JSON parsers mounted inside router) — must come after the router since
// that's where those parsers run.
app.use(bodyParseErrorMiddleware);

// 404 handler - MUST come after all routes
app.use(notFoundHandler);

// Error handler - MUST be last
app.use(errorHandler);

export default app;
