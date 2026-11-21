// src/constants/circuit-breaker.constants.ts

export const CIRCUIT_STATE = {
   CLOSED: 'CLOSED',
   OPEN: 'OPEN',
   HALF_OPEN: 'HALF_OPEN',
} as const;

export type CircuitState = (typeof CIRCUIT_STATE)[keyof typeof CIRCUIT_STATE];

export const CIRCUIT_DEPENDENCY = {
   SOROBAN_RPC: 'soroban_rpc',
   HORIZON: 'horizon',
   REDIS: 'redis',
   DATABASE: 'database',
} as const;

export type CircuitBreakerDependency =
   (typeof CIRCUIT_DEPENDENCY)[keyof typeof CIRCUIT_DEPENDENCY];

export const CIRCUIT_BREAKER_DEFAULTS = {
   ROLLING_WINDOW_SECONDS: 60,
   COOLDOWN_SECONDS: 30,
   FAILURE_THRESHOLD: 5,
   RATE_THRESHOLD_PERCENT: 50,
   MIN_REQUESTS_FOR_RATE: 2,
} as const;
