import cors, { CorsOptions } from 'cors';
import { RequestHandler } from 'express';
import { appConfig } from '../config';

const defaultCorsOptions: CorsOptions = {
   origin: appConfig.allowedOrigins,
   credentials: true,
};

/**
 * Global CORS middleware applied to all routes via app.use().
 * Uses the allowed origins defined in appConfig.
 */
export const corsMiddleware = (): RequestHandler => cors(defaultCorsOptions);

/**
 * Per-endpoint CORS override. Merges the provided options on top of the
 * global defaults so only the fields you specify are changed.
 *
 * Keep secure defaults (allowedOrigins, credentials: true) unless you have
 * an explicit reason to override them.
 *
 * @example
 * // Allow a specific third-party origin on one public webhook route
 * router.post('/webhook', corsOverride({ origin: 'https://partner.example.com', credentials: false }), handler);
 *
 * @example
 * // Expose extra headers on a single endpoint
 * router.get('/export', corsOverride({ exposedHeaders: ['Content-Disposition'] }), exportHandler);
 */
export function corsOverride(options: CorsOptions): RequestHandler {
   return cors({ ...defaultCorsOptions, ...options });
}
