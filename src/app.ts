// src/app.ts
import express, { Express, Response, RequestHandler } from 'express';
import { TspecDocsMiddleware } from 'tspec';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware'; // Add notFoundHandler import
import router from './modules/index';
import { corsMiddleware } from './middlewares/cors.middleware';
import helmet from 'helmet';
import morgan from 'morgan';
import tspecOptions from './tspec.config';
import { SendMail } from './utils/mail.utils';
import { appRateLimit } from './middlewares/rate.middleware';
import { requestIdMiddleware } from './middlewares/request-id.middleware';

const app: Express = express();

// Middleware setup
app.set('trust proxy', 1);
app.use(requestIdMiddleware);
app.use(corsMiddleware());
app.use(helmet());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined'));
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
      console.error('Failed to setup API docs:', error);
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
app.use('/api/v1', router);

// 404 handler - MUST come after all routes
app.use(notFoundHandler);

// Error handler - MUST be last
app.use(errorHandler);

export default app;
