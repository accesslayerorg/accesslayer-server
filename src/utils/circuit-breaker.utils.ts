// src/utils/circuit-breaker.utils.ts
// Multi-tier circuit breaker with per-dependency health tracking and recovery probes (#726).

import { ApiError } from '../middlewares/error.middleware';
import { ErrorCode } from '../constants/error.constants';
import {
   CIRCUIT_STATE,
   CIRCUIT_DEPENDENCY,
   CIRCUIT_BREAKER_DEFAULTS,
   type CircuitState,
   type CircuitBreakerDependency,
} from '../constants/circuit-breaker.constants';
import { logger } from './logger.utils';
import { envConfig } from '../config';

/**
 * Fast-fail error thrown when a call is rejected because the dependency circuit is OPEN.
 * Maps to HTTP 503 dependency_unavailable with a Retry-After header.
 */
export class CircuitBreakerOpenError extends ApiError {
   readonly dependency: string;
   readonly retryAfter: number;

   constructor(
      dependency: string,
      retryAfterSeconds: number,
      message?: string
   ) {
      const remainingSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
      super(
         503,
         message ??
            `Service dependency '${dependency}' is temporarily unavailable (circuit OPEN)`,
         ErrorCode.DEPENDENCY_UNAVAILABLE
      );
      this.name = 'CircuitBreakerOpenError';
      this.dependency = dependency;
      this.retryAfter = remainingSeconds;
   }
}

export interface CircuitBreakerOptions {
   failureThreshold?: number;
   failureRateThreshold?: number;
   windowMs?: number;
   cooldownMs?: number;
   minRequestsForRate?: number;
   probe?: () => Promise<boolean | void>;
   autoProbe?: boolean;
}

export interface CircuitBreakerMetrics {
   name: string;
   state: CircuitState;
   failureCount: number;
   failure_count: number;
   consecutiveFailures: number;
   lastFailure: string | null;
   last_failure: string | null;
   lastSuccess: string | null;
   lastProbe: string | null;
   last_probe: string | null;
   failureRate: number;
   totalRequestsInWindow: number;
   cooldownRemainingMs: number;
   retryAfterSeconds: number;
   thresholds: {
      failureThreshold: number;
      failureRateThreshold: number;
      cooldownSeconds: number;
      windowSeconds: number;
   };
}

interface RollingEvent {
   timestamp: number;
   success: boolean;
}

/**
 * Resolve dynamic configuration for a given dependency name.
 * Allows changing thresholds and cooldowns per dependency via environment variables
 * without requiring any code modifications.
 */
function resolveDependencyConfig(dependencyName: string) {
   const normalized = dependencyName.toUpperCase().replace(/[^A-Z0-9]/g, '_');

   const readEnvNumber = (keys: string[]): number | undefined => {
      for (const key of keys) {
         const val =
            process.env[key] ?? (envConfig as Record<string, any>)[key];
         if (val !== undefined && val !== null && val !== '') {
            const parsed = Number(val);
            if (!Number.isNaN(parsed) && parsed > 0) return parsed;
         }
      }
      return undefined;
   };

   const failureThreshold =
      readEnvNumber([
         `CIRCUIT_BREAKER_${normalized}_FAILURE_THRESHOLD`,
         `CIRCUIT_${normalized}_FAILURE_THRESHOLD`,
         'CIRCUIT_BREAKER_FAILURE_THRESHOLD',
      ]) ?? CIRCUIT_BREAKER_DEFAULTS.FAILURE_THRESHOLD;

   const failureRateThreshold =
      readEnvNumber([
         `CIRCUIT_BREAKER_${normalized}_RATE_THRESHOLD`,
         `CIRCUIT_${normalized}_RATE_THRESHOLD`,
         'CIRCUIT_BREAKER_RATE_THRESHOLD',
      ]) ?? CIRCUIT_BREAKER_DEFAULTS.RATE_THRESHOLD_PERCENT;

   const cooldownSeconds =
      readEnvNumber([
         `CIRCUIT_BREAKER_${normalized}_COOLDOWN_SECONDS`,
         `CIRCUIT_${normalized}_COOLDOWN_SECONDS`,
         'CIRCUIT_BREAKER_COOLDOWN_SECONDS',
      ]) ?? CIRCUIT_BREAKER_DEFAULTS.COOLDOWN_SECONDS;

   const windowSeconds =
      readEnvNumber([
         `CIRCUIT_BREAKER_${normalized}_WINDOW_SECONDS`,
         `CIRCUIT_${normalized}_WINDOW_SECONDS`,
         'CIRCUIT_BREAKER_WINDOW_SECONDS',
      ]) ?? CIRCUIT_BREAKER_DEFAULTS.ROLLING_WINDOW_SECONDS;

   return {
      failureThreshold,
      failureRateThreshold,
      cooldownMs: cooldownSeconds * 1000,
      windowMs: windowSeconds * 1000,
   };
}

export class CircuitBreaker {
   readonly name: string;
   private state: CircuitState = CIRCUIT_STATE.CLOSED;
   private consecutiveFailures = 0;
   private lastFailure: Date | null = null;
   private lastSuccess: Date | null = null;
   private lastProbe: Date | null = null;
   private openedAt: number | null = null;
   private halfOpenInFlight = false;
   private rollingEvents: RollingEvent[] = [];
   private probeTimer: NodeJS.Timeout | null = null;

   private explicitOptions: CircuitBreakerOptions;
   private probeFn?: () => Promise<boolean | void>;

   constructor(name: string, options: CircuitBreakerOptions = {}) {
      this.name = name;
      this.explicitOptions = options;
      this.probeFn = options.probe;
   }

   private get resolvedConfig() {
      const dynamic = resolveDependencyConfig(this.name);
      const failureThreshold =
         this.explicitOptions.failureThreshold ?? dynamic.failureThreshold;
      return {
         failureThreshold,
         failureRateThreshold:
            this.explicitOptions.failureRateThreshold ??
            dynamic.failureRateThreshold,
         cooldownMs: this.explicitOptions.cooldownMs ?? dynamic.cooldownMs,
         windowMs: this.explicitOptions.windowMs ?? dynamic.windowMs,
         minRequestsForRate:
            this.explicitOptions.minRequestsForRate ??
            Math.max(failureThreshold, 5),
         autoProbe: this.explicitOptions.autoProbe ?? true,
      };
   }

   public getState(): CircuitState {
      // If OPEN and cooldown has passed, allow state reflection as HALF_OPEN
      if (this.state === CIRCUIT_STATE.OPEN) {
         const elapsed = Date.now() - (this.openedAt ?? 0);
         if (
            elapsed >= this.resolvedConfig.cooldownMs &&
            !this.halfOpenInFlight
         ) {
            this.transitionToHalfOpen();
         }
      }
      return this.state;
   }

   public isOpen(): boolean {
      return this.getState() === CIRCUIT_STATE.OPEN;
   }

   public isClosed(): boolean {
      return this.getState() === CIRCUIT_STATE.CLOSED;
   }

   public isHalfOpen(): boolean {
      return this.getState() === CIRCUIT_STATE.HALF_OPEN;
   }

   public getFailureCount(): number {
      return this.consecutiveFailures;
   }

   public getConsecutiveFailures(): number {
      return this.consecutiveFailures;
   }

   public getLastFailure(): Date | null {
      return this.lastFailure;
   }

   public getLastProbe(): Date | null {
      return this.lastProbe;
   }

   public getRemainingCooldownMs(): number {
      if (this.state !== CIRCUIT_STATE.OPEN || this.openedAt === null) {
         return 0;
      }
      const elapsed = Date.now() - this.openedAt;
      return Math.max(0, this.resolvedConfig.cooldownMs - elapsed);
   }

   public getRemainingCooldownSeconds(): number {
      return Math.max(1, Math.ceil(this.getRemainingCooldownMs() / 1000));
   }

   private cleanRollingWindow(now = Date.now()): void {
      const cutoff = now - this.resolvedConfig.windowMs;
      this.rollingEvents = this.rollingEvents.filter(
         e => e.timestamp >= cutoff
      );
   }

   public getFailureRate(): number {
      this.cleanRollingWindow();
      if (this.rollingEvents.length === 0) return 0;
      const failures = this.rollingEvents.filter(e => !e.success).length;
      return Math.round((failures / this.rollingEvents.length) * 100);
   }

   public setProbeFunction(fn: () => Promise<boolean | void>): void {
      this.probeFn = fn;
   }

   private clearProbeTimer(): void {
      if (this.probeTimer) {
         clearTimeout(this.probeTimer);
         this.probeTimer = null;
      }
   }

   private scheduleRecoveryProbe(): void {
      if (!this.resolvedConfig.autoProbe || !this.probeFn) return;
      if (
         process.env.MODE === 'test' &&
         this.explicitOptions.autoProbe !== true
      ) {
         return;
      }
      this.clearProbeTimer();

      const remainingMs = this.getRemainingCooldownMs();
      const delay = Math.max(50, remainingMs);

      this.probeTimer = setTimeout(async () => {
         try {
            await this.probe();
         } catch {
            // Handled inside probe()
         }
      }, delay);

      if (this.probeTimer && typeof this.probeTimer.unref === 'function') {
         this.probeTimer.unref();
      }
   }

   private transitionToOpen(): void {
      this.state = CIRCUIT_STATE.OPEN;
      this.openedAt = Date.now();
      this.halfOpenInFlight = false;

      const transitionTimestamp = new Date().toISOString();
      logger.warn(
         {
            event: 'circuit_opened',
            type: 'circuit_opened',
            circuit_opened: true,
            dependency: this.name,
            failure_count: this.consecutiveFailures,
            transition_timestamp: transitionTimestamp,
         },
         `Circuit breaker opened for ${this.name}`
      );

      this.scheduleRecoveryProbe();
   }

   private transitionToHalfOpen(): void {
      this.state = CIRCUIT_STATE.HALF_OPEN;
      this.halfOpenInFlight = false;

      const transitionTimestamp = new Date().toISOString();
      logger.info(
         {
            event: 'circuit_half_opened',
            type: 'circuit_half_opened',
            circuit_half_opened: true,
            dependency: this.name,
            failure_count: this.consecutiveFailures,
            transition_timestamp: transitionTimestamp,
         },
         `Circuit breaker half-opened for ${this.name}`
      );
   }

   private transitionToClosed(): void {
      this.state = CIRCUIT_STATE.CLOSED;
      this.consecutiveFailures = 0;
      this.halfOpenInFlight = false;
      this.openedAt = null;
      this.clearProbeTimer();

      const transitionTimestamp = new Date().toISOString();
      logger.info(
         {
            event: 'circuit_closed',
            type: 'circuit_closed',
            circuit_closed: true,
            dependency: this.name,
            failure_count: 0,
            transition_timestamp: transitionTimestamp,
         },
         `Circuit breaker closed for ${this.name}`
      );
   }

   public openCircuit(): void {
      this.transitionToOpen();
   }

   public halfOpenCircuit(): void {
      this.transitionToHalfOpen();
   }

   public closeCircuit(): void {
      this.transitionToClosed();
   }

   public recordSuccess(): void {
      const now = Date.now();
      this.lastSuccess = new Date(now);
      this.consecutiveFailures = 0;
      this.cleanRollingWindow(now);
      this.rollingEvents.push({ timestamp: now, success: true });

      if (this.state === CIRCUIT_STATE.HALF_OPEN) {
         this.transitionToClosed();
      }
   }

   public recordFailure(_error?: unknown): void {
      const now = Date.now();
      this.consecutiveFailures++;
      this.lastFailure = new Date(now);
      this.cleanRollingWindow(now);
      this.rollingEvents.push({ timestamp: now, success: false });

      if (this.state === CIRCUIT_STATE.HALF_OPEN) {
         // Probe failure re-opens circuit
         this.transitionToOpen();
         return;
      }

      if (this.state === CIRCUIT_STATE.CLOSED) {
         const config = this.resolvedConfig;
         const rate = this.getFailureRate();
         const hasEnoughRequests =
            this.rollingEvents.length >= config.minRequestsForRate;

         if (
            this.consecutiveFailures >= config.failureThreshold ||
            (hasEnoughRequests && rate > config.failureRateThreshold)
         ) {
            this.transitionToOpen();
         }
      }
   }

   /**
    * Throws CircuitBreakerOpenError if the circuit is currently OPEN and within cooldown.
    * Automatically advances OPEN -> HALF_OPEN when cooldown has elapsed.
    */
   public checkState(): void {
      const currentState = this.getState();
      if (currentState === CIRCUIT_STATE.OPEN) {
         throw new CircuitBreakerOpenError(
            this.name,
            this.getRemainingCooldownSeconds()
         );
      }
   }

   /**
    * Executes an action protected by this circuit breaker.
    * Rejects fast with CircuitBreakerOpenError (503) if OPEN.
    * In HALF_OPEN state, allows one probe request through.
    */
   public async execute<T>(action: () => Promise<T>): Promise<T> {
      const currentState = this.getState();

      if (currentState === CIRCUIT_STATE.OPEN) {
         throw new CircuitBreakerOpenError(
            this.name,
            this.getRemainingCooldownSeconds()
         );
      }

      if (currentState === CIRCUIT_STATE.HALF_OPEN) {
         if (this.halfOpenInFlight) {
            // Only allow one probe request through in HALF_OPEN
            throw new CircuitBreakerOpenError(
               this.name,
               this.getRemainingCooldownSeconds()
            );
         }

         this.halfOpenInFlight = true;
         this.lastProbe = new Date();

         try {
            const result = await action();
            this.recordSuccess();
            return result;
         } catch (err) {
            this.recordFailure(err);
            throw err;
         } finally {
            this.halfOpenInFlight = false;
         }
      }

      // State is CLOSED
      try {
         const result = await action();
         this.recordSuccess();
         return result;
      } catch (err) {
         this.recordFailure(err);
         throw err;
      }
   }

   /**
    * Explicit or automatic probe execution to test dependency recovery.
    * Success closes circuit; failure re-opens circuit.
    */
   public async probe(): Promise<boolean> {
      if (!this.probeFn) return true;

      // Ensure state is HALF_OPEN for probe
      if (this.state === CIRCUIT_STATE.OPEN) {
         this.transitionToHalfOpen();
      }

      this.halfOpenInFlight = true;
      this.lastProbe = new Date();

      try {
         const res = await this.probeFn();
         if (res === false) {
            this.transitionToOpen();
            return false;
         }
         this.transitionToClosed();
         return true;
      } catch {
         this.transitionToOpen();
         return false;
      } finally {
         this.halfOpenInFlight = false;
      }
   }

   public getMetrics(): CircuitBreakerMetrics {
      const state = this.getState();
      const config = this.resolvedConfig;
      const cooldownRemainingMs = this.getRemainingCooldownMs();
      const retryAfterSeconds = Math.ceil(cooldownRemainingMs / 1000);

      const lastFailureIso = this.lastFailure?.toISOString() ?? null;
      const lastProbeIso = this.lastProbe?.toISOString() ?? null;

      return {
         name: this.name,
         state,
         failureCount: this.consecutiveFailures,
         failure_count: this.consecutiveFailures,
         consecutiveFailures: this.consecutiveFailures,
         lastFailure: lastFailureIso,
         last_failure: lastFailureIso,
         lastSuccess: this.lastSuccess?.toISOString() ?? null,
         lastProbe: lastProbeIso,
         last_probe: lastProbeIso,
         failureRate: this.getFailureRate(),
         totalRequestsInWindow: this.rollingEvents.length,
         cooldownRemainingMs,
         retryAfterSeconds,
         thresholds: {
            failureThreshold: config.failureThreshold,
            failureRateThreshold: config.failureRateThreshold,
            cooldownSeconds: Math.round(config.cooldownMs / 1000),
            windowSeconds: Math.round(config.windowMs / 1000),
         },
      };
   }

   public reset(): void {
      this.clearProbeTimer();
      this.state = CIRCUIT_STATE.CLOSED;
      this.consecutiveFailures = 0;
      this.lastFailure = null;
      this.lastSuccess = null;
      this.lastProbe = null;
      this.openedAt = null;
      this.halfOpenInFlight = false;
      this.rollingEvents = [];
   }

   public destroy(): void {
      this.clearProbeTimer();
   }
}

// ── Dependency Instances ──────────────────────────────────────

export const sorobanRpcCircuitBreaker = new CircuitBreaker(
   CIRCUIT_DEPENDENCY.SOROBAN_RPC,
   {
      probe: async () => {
         const url = envConfig.STELLAR_SOROBAN_RPC_URL;
         if (!url) return true;
         const controller = new AbortController();
         const timer = setTimeout(() => controller.abort(), 3000);
         try {
            const res = await fetch(url, {
               method: 'POST',
               headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify({
                  jsonrpc: '2.0',
                  id: 'probe',
                  method: 'getHealth',
               }),
               signal: controller.signal,
            });
            return res.ok;
         } finally {
            clearTimeout(timer);
         }
      },
   }
);

export const horizonCircuitBreaker = new CircuitBreaker(
   CIRCUIT_DEPENDENCY.HORIZON,
   {
      probe: async () => {
         const base = envConfig.STELLAR_HORIZON_URL?.replace(/\/$/, '');
         if (!base) return true;
         const controller = new AbortController();
         const timer = setTimeout(() => controller.abort(), 3000);
         try {
            const res = await fetch(`${base}/`, {
               method: 'GET',
               signal: controller.signal,
            });
            return res.ok;
         } finally {
            clearTimeout(timer);
         }
      },
   }
);

export const redisCircuitBreaker = new CircuitBreaker(
   CIRCUIT_DEPENDENCY.REDIS,
   {
      probe: async () => {
         const { getRedisClient } = await import('./redis.utils');
         const client = getRedisClient();
         if (!client) return true;
         const pong = await client.ping();
         return pong === 'PONG';
      },
   }
);

export const databaseCircuitBreaker = new CircuitBreaker(
   CIRCUIT_DEPENDENCY.DATABASE,
   {
      probe: async () => {
         const { prisma } = await import('./prisma.utils');
         await prisma.$queryRaw`SELECT 1`;
         return true;
      },
   }
);

export const circuitBreakers: Record<CircuitBreakerDependency, CircuitBreaker> =
   {
      [CIRCUIT_DEPENDENCY.SOROBAN_RPC]: sorobanRpcCircuitBreaker,
      [CIRCUIT_DEPENDENCY.HORIZON]: horizonCircuitBreaker,
      [CIRCUIT_DEPENDENCY.REDIS]: redisCircuitBreaker,
      [CIRCUIT_DEPENDENCY.DATABASE]: databaseCircuitBreaker,
   };

export function getCircuitBreaker(
   name: CircuitBreakerDependency | string
): CircuitBreaker | undefined {
   const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
   if (normalized === 'db' || normalized === 'database_pool') {
      return databaseCircuitBreaker;
   }
   if (normalized === 'soroban' || normalized === 'sorobanrpc') {
      return sorobanRpcCircuitBreaker;
   }
   return circuitBreakers[normalized as CircuitBreakerDependency];
}

/** Resets all circuit breakers to CLOSED state (useful between tests). */
export function resetAllCircuitBreakers(): void {
   for (const cb of Object.values(circuitBreakers)) {
      cb.reset();
   }
}
