// src/modules/keys/circuit-breaker.schemas.ts
// Query schema for GET /keys/:keyId/circuit-breaker (#987).

import { z } from 'zod';
import { safeIntParam } from '../../utils/query.utils';

/** Trip history is paginated; the last 50 trips are returned by default. */
export const CIRCUIT_BREAKER_TRIP_DEFAULT_LIMIT = 50;
export const CIRCUIT_BREAKER_TRIP_MAX_LIMIT = 100;

export const circuitBreakerQuerySchema = z.object({
   limit: safeIntParam({
      defaultValue: CIRCUIT_BREAKER_TRIP_DEFAULT_LIMIT,
      min: 1,
      max: CIRCUIT_BREAKER_TRIP_MAX_LIMIT,
      label: 'Limit',
   }),

   offset: safeIntParam({
      defaultValue: 0,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      label: 'Offset',
   }),
});

export type CircuitBreakerQuery = z.infer<typeof circuitBreakerQuerySchema>;
