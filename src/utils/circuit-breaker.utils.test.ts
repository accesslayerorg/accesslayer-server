// src/utils/circuit-breaker.utils.test.ts
// Unit tests for multi-tier circuit breaker (#726).

import {
   CircuitBreaker,
   CircuitBreakerOpenError,
   getCircuitBreaker,
   resetAllCircuitBreakers,
   sorobanRpcCircuitBreaker,
   horizonCircuitBreaker,
   redisCircuitBreaker,
   databaseCircuitBreaker,
} from './circuit-breaker.utils';
import {
   CIRCUIT_STATE,
   CIRCUIT_DEPENDENCY,
} from '../constants/circuit-breaker.constants';
import { logger } from './logger.utils';

jest.mock('./logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

describe('CircuitBreaker (#726)', () => {
   const mockLogger = logger as unknown as {
      info: jest.Mock;
      warn: jest.Mock;
   };

   beforeEach(() => {
      jest.clearAllMocks();
      resetAllCircuitBreakers();
   });

   afterEach(() => {
      resetAllCircuitBreakers();
   });

   describe('State transitions and failure threshold', () => {
      it('starts in CLOSED state with 0 failures', () => {
         const breaker = new CircuitBreaker('test_dep', {
            failureThreshold: 3,
            cooldownMs: 5000,
            autoProbe: false,
         });

         expect(breaker.getState()).toBe(CIRCUIT_STATE.CLOSED);
         expect(breaker.isOpen()).toBe(false);
         expect(breaker.isClosed()).toBe(true);
         expect(breaker.getFailureCount()).toBe(0);
         expect(breaker.getLastFailure()).toBeNull();
         expect(breaker.getLastProbe()).toBeNull();
      });

      it('opens after N consecutive failures and emits circuit_opened structured log', async () => {
         const breaker = new CircuitBreaker('test_dep', {
            failureThreshold: 3,
            cooldownMs: 5000,
            autoProbe: false,
         });

         const failingAction = jest
            .fn()
            .mockRejectedValue(new Error('Network failure'));

         // Failure 1
         await expect(breaker.execute(failingAction)).rejects.toThrow(
            'Network failure'
         );
         expect(breaker.getState()).toBe(CIRCUIT_STATE.CLOSED);
         expect(breaker.getFailureCount()).toBe(1);

         // Failure 2
         await expect(breaker.execute(failingAction)).rejects.toThrow(
            'Network failure'
         );
         expect(breaker.getState()).toBe(CIRCUIT_STATE.CLOSED);
         expect(breaker.getFailureCount()).toBe(2);

         // Failure 3 -> Trips to OPEN!
         await expect(breaker.execute(failingAction)).rejects.toThrow(
            'Network failure'
         );
         expect(breaker.getState()).toBe(CIRCUIT_STATE.OPEN);
         expect(breaker.isOpen()).toBe(true);
         expect(breaker.getFailureCount()).toBe(3);
         expect(breaker.getLastFailure()).toBeInstanceOf(Date);

         // Check structured log emitted on circuit_opened
         expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
               event: 'circuit_opened',
               dependency: 'test_dep',
               failure_count: 3,
               transition_timestamp: expect.any(String),
            }),
            'Circuit breaker opened for test_dep'
         );
      });

      it('resets consecutive failures counter on success while CLOSED', async () => {
         const breaker = new CircuitBreaker('test_dep', {
            failureThreshold: 3,
            cooldownMs: 5000,
            autoProbe: false,
         });

         const failingAction = jest
            .fn()
            .mockRejectedValue(new Error('Transient failure'));
         const successAction = jest.fn().mockResolvedValue('ok');

         await expect(breaker.execute(failingAction)).rejects.toThrow();
         await expect(breaker.execute(failingAction)).rejects.toThrow();
         expect(breaker.getFailureCount()).toBe(2);

         // Success resets consecutive failures
         await expect(breaker.execute(successAction)).resolves.toBe('ok');
         expect(breaker.getFailureCount()).toBe(0);
         expect(breaker.getState()).toBe(CIRCUIT_STATE.CLOSED);
      });

      it('opens when failure rate exceeds X% in rolling 60s window', async () => {
         const breaker = new CircuitBreaker('test_dep', {
            failureThreshold: 10, // high consecutive threshold
            failureRateThreshold: 50, // 50%
            minRequestsForRate: 4,
            windowMs: 60000,
            cooldownMs: 5000,
            autoProbe: false,
         });

         // 1 success
         breaker.recordSuccess();
         expect(breaker.getFailureRate()).toBe(0);

         // 1 failure (1/2 = 50%)
         breaker.recordFailure();
         expect(breaker.getFailureRate()).toBe(50);
         expect(breaker.getState()).toBe(CIRCUIT_STATE.CLOSED); // not > 50%

         // 1 success (1/3 = 33%)
         breaker.recordSuccess();
         expect(breaker.getState()).toBe(CIRCUIT_STATE.CLOSED);

         // 2 failures (3/5 = 60% > 50%)
         breaker.recordFailure();
         breaker.recordFailure();

         expect(breaker.getState()).toBe(CIRCUIT_STATE.OPEN);
         expect(breaker.getFailureRate()).toBeGreaterThan(50);
      });
   });

   describe('OPEN state fast-fail', () => {
      it('fast-fails calls with CircuitBreakerOpenError (503 and Retry-After) without executing action', async () => {
         const breaker = new CircuitBreaker('test_dep', {
            failureThreshold: 2,
            cooldownMs: 30000,
            autoProbe: false,
         });

         breaker.recordFailure();
         breaker.recordFailure();
         expect(breaker.getState()).toBe(CIRCUIT_STATE.OPEN);

         const action = jest.fn().mockResolvedValue('should not run');

         let caughtError: any;
         try {
            await breaker.execute(action);
         } catch (err) {
            caughtError = err;
         }

         expect(caughtError).toBeInstanceOf(CircuitBreakerOpenError);
         expect(caughtError.statusCode).toBe(503);
         expect(caughtError.errorCode).toBe('dependency_unavailable');
         expect(caughtError.dependency).toBe('test_dep');
         expect(caughtError.retryAfter).toBeGreaterThanOrEqual(1);
         expect(caughtError.retryAfter).toBeLessThanOrEqual(30);

         // Action was never executed
         expect(action).not.toHaveBeenCalled();
      });
   });

   describe('OPEN -> HALF_OPEN -> CLOSED (probe recovery)', () => {
      it('allows one probe request through after cooldown and closes on success', async () => {
         const breaker = new CircuitBreaker('test_dep', {
            failureThreshold: 1,
            cooldownMs: 100, // 100ms cooldown for test speed
            autoProbe: false,
         });

         breaker.recordFailure();
         expect(breaker.getState()).toBe(CIRCUIT_STATE.OPEN);

         // Wait for cooldown to expire
         await new Promise(resolve => setTimeout(resolve, 150));

         // Now cooldown has elapsed; call should be allowed through as probe
         const probeAction = jest.fn().mockResolvedValue('recovery_success');
         const result = await breaker.execute(probeAction);

         expect(probeAction).toHaveBeenCalledTimes(1);
         expect(result).toBe('recovery_success');
         expect(breaker.getState()).toBe(CIRCUIT_STATE.CLOSED);
         expect(breaker.getFailureCount()).toBe(0);
         expect(breaker.getLastProbe()).toBeInstanceOf(Date);

         // Check structured logs emitted for transitions
         expect(mockLogger.info).toHaveBeenCalledWith(
            expect.objectContaining({
               event: 'circuit_half_opened',
               dependency: 'test_dep',
            }),
            'Circuit breaker half-opened for test_dep'
         );
         expect(mockLogger.info).toHaveBeenCalledWith(
            expect.objectContaining({
               event: 'circuit_closed',
               dependency: 'test_dep',
               failure_count: 0,
            }),
            'Circuit breaker closed for test_dep'
         );
      });

      it('re-opens circuit when probe fails and resets cooldown', async () => {
         const breaker = new CircuitBreaker('test_dep', {
            failureThreshold: 1,
            cooldownMs: 100,
            autoProbe: false,
         });

         breaker.recordFailure();
         expect(breaker.getState()).toBe(CIRCUIT_STATE.OPEN);

         await new Promise(resolve => setTimeout(resolve, 150));

         const failingProbe = jest
            .fn()
            .mockRejectedValue(new Error('Probe still down'));
         await expect(breaker.execute(failingProbe)).rejects.toThrow(
            'Probe still down'
         );

         expect(breaker.getState()).toBe(CIRCUIT_STATE.OPEN);
         expect(breaker.getLastProbe()).toBeInstanceOf(Date);

         // Structured log circuit_opened emitted again on probe failure
         expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
               event: 'circuit_opened',
               dependency: 'test_dep',
            }),
            'Circuit breaker opened for test_dep'
         );
      });

      it('probe() method closes circuit on success and re-opens on failure', async () => {
         let shouldSucceed = false;
         const breaker = new CircuitBreaker('test_dep', {
            failureThreshold: 1,
            cooldownMs: 50,
            probe: async () => {
               if (!shouldSucceed) throw new Error('Unhealthy');
               return true;
            },
            autoProbe: false,
         });

         breaker.recordFailure();
         expect(breaker.getState()).toBe(CIRCUIT_STATE.OPEN);

         // Probe fails
         const probeResult1 = await breaker.probe();
         expect(probeResult1).toBe(false);
         expect(breaker.getState()).toBe(CIRCUIT_STATE.OPEN);

         // Probe succeeds
         shouldSucceed = true;
         const probeResult2 = await breaker.probe();
         expect(probeResult2).toBe(true);
         expect(breaker.getState()).toBe(CIRCUIT_STATE.CLOSED);
      });
   });

   describe('Metrics exposure', () => {
      it('returns comprehensive metrics matching all required fields', () => {
         const breaker = new CircuitBreaker('soroban_rpc', {
            failureThreshold: 4,
            failureRateThreshold: 60,
            cooldownMs: 15000,
            windowMs: 45000,
            autoProbe: false,
         });

         breaker.recordFailure();

         const metrics = breaker.getMetrics();
         expect(metrics).toMatchObject({
            name: 'soroban_rpc',
            state: CIRCUIT_STATE.CLOSED,
            failureCount: 1,
            failure_count: 1,
            consecutiveFailures: 1,
            lastFailure: expect.any(String),
            lastProbe: null,
            thresholds: {
               failureThreshold: 4,
               failureRateThreshold: 60,
               cooldownSeconds: 15,
               windowSeconds: 45,
            },
         });
      });
   });

   describe('Separate instances and registry', () => {
      it('maintains separate instances for Soroban RPC, Horizon, Redis, and Database', () => {
         expect(sorobanRpcCircuitBreaker.name).toBe(
            CIRCUIT_DEPENDENCY.SOROBAN_RPC
         );
         expect(horizonCircuitBreaker.name).toBe(CIRCUIT_DEPENDENCY.HORIZON);
         expect(redisCircuitBreaker.name).toBe(CIRCUIT_DEPENDENCY.REDIS);
         expect(databaseCircuitBreaker.name).toBe(CIRCUIT_DEPENDENCY.DATABASE);

         expect(getCircuitBreaker('soroban_rpc')).toBe(
            sorobanRpcCircuitBreaker
         );
         expect(getCircuitBreaker('horizon')).toBe(horizonCircuitBreaker);
         expect(getCircuitBreaker('redis')).toBe(redisCircuitBreaker);
         expect(getCircuitBreaker('database')).toBe(databaseCircuitBreaker);

         // Alias support
         expect(getCircuitBreaker('db')).toBe(databaseCircuitBreaker);
         expect(getCircuitBreaker('database_pool')).toBe(
            databaseCircuitBreaker
         );
         expect(getCircuitBreaker('soroban')).toBe(sorobanRpcCircuitBreaker);

         // Verify instances are isolated
         sorobanRpcCircuitBreaker.openCircuit();
         expect(sorobanRpcCircuitBreaker.isOpen()).toBe(true);
         expect(horizonCircuitBreaker.isOpen()).toBe(false);
         expect(redisCircuitBreaker.isOpen()).toBe(false);
         expect(databaseCircuitBreaker.isOpen()).toBe(false);
      });
   });

   describe('Configuration without code changes', () => {
      const origEnv = process.env;

      beforeEach(() => {
         process.env = { ...origEnv };
      });

      afterEach(() => {
         process.env = origEnv;
      });

      it('reads per-dependency thresholds from environment variables dynamically', () => {
         process.env.CIRCUIT_BREAKER_HORIZON_FAILURE_THRESHOLD = '12';
         process.env.CIRCUIT_BREAKER_HORIZON_COOLDOWN_SECONDS = '45';

         const breaker = new CircuitBreaker('horizon', { autoProbe: false });
         const metrics = breaker.getMetrics();

         expect(metrics.thresholds.failureThreshold).toBe(12);
         expect(metrics.thresholds.cooldownSeconds).toBe(45);
      });
   });
});
