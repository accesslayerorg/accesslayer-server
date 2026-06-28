import { logger } from '../../utils/logger.utils';

const creatorRouteBootMs = Date.now();
const loggedHandlers = new Set<string>();

/**
 * Emits a one-time debug log for the first invocation of a creator route handler.
 *
 * The log is intentionally debug-level so it stays out of production info logs
 * while still giving operators a signal when a route's first request is slower
 * than expected.
 */
export function logCreatorRouteColdStart(
   handler: string,
   requestId?: string
): void {
   if (loggedHandlers.has(handler)) {
      return;
   }

   loggedHandlers.add(handler);

   logger.debug(
      {
         type: 'creator_route_cold_start',
         handler,
         elapsedMs: Date.now() - creatorRouteBootMs,
         ...(requestId ? { requestId } : {}),
      },
      'Creator route cold start detected'
   );
}
