// src/middlewares/circuit-breaker.middleware.ts
// Route middleware for fast-failing endpoints that depend on degraded upstream services.

import { Request, Response, NextFunction } from 'express';
import {
   getCircuitBreaker,
   CircuitBreakerOpenError,
} from '../utils/circuit-breaker.utils';
import { type CircuitBreakerDependency } from '../constants/circuit-breaker.constants';

/**
 * Ensures specified circuit breakers are not in OPEN state before executing the route handler.
 * If any circuit is OPEN, immediately returns 503 dependency_unavailable with a Retry-After header.
 */
export function requireCircuitClosed(
   ...dependencies: (CircuitBreakerDependency | string)[]
) {
   return (_req: Request, _res: Response, next: NextFunction): void => {
      for (const dep of dependencies) {
         const breaker = getCircuitBreaker(dep);
         if (breaker && breaker.isOpen()) {
            throw new CircuitBreakerOpenError(
               breaker.name,
               breaker.getRemainingCooldownSeconds()
            );
         }
      }
      next();
   };
}
