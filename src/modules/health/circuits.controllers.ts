// src/modules/health/circuits.controllers.ts
// Exposes circuit states and metrics for internal network callers (#726).

import { Request, Response } from 'express';
import { circuitBreakers } from '../../utils/circuit-breaker.utils';

/**
 * GET /internal/health/circuits
 *
 * Exposes current circuit breaker state, failure counts, last failure,
 * and last probe timestamps across all tracked dependencies.
 * Internal network only.
 */
export const getCircuitsHealth = (_req: Request, res: Response): void => {
   const circuits: Record<string, any> = {};
   let allHealthy = true;

   for (const [dep, breaker] of Object.entries(circuitBreakers)) {
      const metrics = breaker.getMetrics();
      circuits[dep] = metrics;
      if (metrics.state === 'OPEN') {
         allHealthy = false;
      }
   }

   res.status(200).json({
      success: true,
      status: allHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      circuits,
   });
};
