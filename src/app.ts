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
import { corsMiddleware } from './middlewares/cors.middleware';
import helmet from 'helmet';
import morgan from 'morgan';
import tspecOptions from './tspec.config';
import { SendMail } from './utils/mail.utils';
import { appRateLimit } from './middlewares/rate.middleware';
import { requestIdMiddleware } from './middlewares/request-id.middleware';
import { responseTimingMiddleware } from './middlewares/response-timing.middleware';
import { apiVersionMiddleware } from './middlewares/api-version.middleware';
import { schemaVersionMiddleware } from './middlewares/schema-version.middleware';
import { requestLoggerMiddleware } from './middlewares/request-logger.middleware';
import { requestContextMiddleware } from './middlewares/request-context.middleware';
import { requestEntryLoggerMiddleware } from './middlewares/request-entry-logger.middleware';
import { requestCompletionLoggerMiddleware, slowRequestLoggerMiddleware } from './middlewares/request-completion-logger.middleware';
import { sessionActivityMiddleware } from './middlewares/session-activity.middleware';
import { bodyParseErrorMiddleware } from './middlewares/body-parse-error.middleware';
import { routeBodySizeLimit } from './middlewares/body-size-limit.middleware';
import { envConfig } from './config';
import { logger } from './utils/logger.utils';

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
app.use('/status', routeBodySizeLimit('default'), statusRouter);
app.use('/nonce', routeBodySizeLimit('default'), nonceRouter);
app.use('/internal', routeBodySizeLimit('default'), internalRouter);
app.use('/api/v1', router);
app.use('/staking', routeBodySizeLimit('default'), stakingRouter);
app.use('/trades', routeBodySizeLimit('default'), tradesRouter);
app.use('/traders', routeBodySizeLimit('default'), tradersRouter);
app.use('/keys', routeBodySizeLimit('default'), keysRouter);
app.use('/milestones', routeBodySizeLimit('default'), milestonesRouter);
app.use('/swaps', routeBodySizeLimit('default'), swapsRouter);
app.use('/events', routeBodySizeLimit('default'), eventsRouter);

// Catches body-parse errors (including entity.too.large from the per-group
// JSON parsers mounted inside router) — must come after the router since
// that's where those parsers run.
app.use(bodyParseErrorMiddleware);

// 404 handler - MUST come after all routes
app.use(notFoundHandler);

// Error handler - MUST be last
app.use(errorHandler);

export default app;
