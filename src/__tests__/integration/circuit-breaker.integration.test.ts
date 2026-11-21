// src/__tests__/integration/circuit-breaker.integration.test.ts
// Integration tests for multi-tier circuit breaker (#726).

import supertest from 'supertest';
import app from '../../app';
import {
   sorobanRpcCircuitBreaker,
   horizonCircuitBreaker,
   resetAllCircuitBreakers,
} from '../../utils/circuit-breaker.utils';
import { CIRCUIT_STATE } from '../../constants/circuit-breaker.constants';
import { disconnectRedis } from '../../utils/redis.utils';

describe('Circuit Breaker Integration Tests (#726)', () => {
   beforeEach(() => {
      resetAllCircuitBreakers();
   });

   afterEach(() => {
      resetAllCircuitBreakers();
   });

   afterAll(async () => {
      await disconnectRedis();
   });

   describe('GET /internal/health/circuits', () => {
      it('returns 200 and exposes initial state and metrics for all 4 dependencies', async () => {
         const res = await supertest(app)
            .get('/internal/health/circuits')
            .set('x-forwarded-for', '127.0.0.1');

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.status).toBe('ok');
         expect(res.body.circuits).toBeDefined();

         const { soroban_rpc, horizon, redis, database } = res.body.circuits;

         expect(soroban_rpc).toBeDefined();
         expect(soroban_rpc.state).toBe(CIRCUIT_STATE.CLOSED);
         expect(soroban_rpc.failureCount).toBe(0);
         expect(soroban_rpc.lastFailure).toBeNull();
         expect(soroban_rpc.lastProbe).toBeNull();

         expect(horizon).toBeDefined();
         expect(horizon.state).toBe(CIRCUIT_STATE.CLOSED);
         expect(horizon.failureCount).toBe(0);

         expect(redis).toBeDefined();
         expect(redis.state).toBe(CIRCUIT_STATE.CLOSED);

         expect(database).toBeDefined();
         expect(database.state).toBe(CIRCUIT_STATE.CLOSED);
      });

      it('also responds at /api/v1/internal/health/circuits', async () => {
         const res = await supertest(app)
            .get('/api/v1/internal/health/circuits')
            .set('x-forwarded-for', '127.0.0.1');

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.circuits).toBeDefined();
      });

      it('rejects external network requests without internal authorization with 403 Forbidden', async () => {
         const res = await supertest(app)
            .get('/internal/health/circuits')
            .set('x-forwarded-for', '203.0.113.195');

         expect(res.status).toBe(403);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('FORBIDDEN');
         expect(res.body.error.message).toContain('internal network');
      });

      it('allows private network ranges (10.0.0.0/8, 192.168.0.0/16, 172.16.0.0/12)', async () => {
         for (const internalIp of ['10.1.2.3', '192.168.1.50', '172.20.0.1']) {
            const res = await supertest(app)
               .get('/internal/health/circuits')
               .set('x-forwarded-for', internalIp);

            expect(res.status).toBe(200);
         }
      });
   });

   describe('Failures trigger OPEN state & health endpoint reflects current state', () => {
      it('health endpoint reflects OPEN state, failure count, and last failure when circuit opens', async () => {
         // Record consecutive failures on Soroban RPC to trip it
         const failureThreshold = 5;
         for (let i = 0; i < failureThreshold; i++) {
            sorobanRpcCircuitBreaker.recordFailure(
               new Error('RPC node unavailable')
            );
         }

         expect(sorobanRpcCircuitBreaker.isOpen()).toBe(true);

         const res = await supertest(app)
            .get('/internal/health/circuits')
            .set('x-forwarded-for', '127.0.0.1');

         expect(res.status).toBe(200);
         expect(res.body.status).toBe('degraded');
         expect(res.body.circuits.soroban_rpc.state).toBe(CIRCUIT_STATE.OPEN);
         expect(res.body.circuits.soroban_rpc.failureCount).toBe(
            failureThreshold
         );
         expect(res.body.circuits.soroban_rpc.lastFailure).not.toBeNull();

         // Other circuits remain CLOSED
         expect(res.body.circuits.horizon.state).toBe(CIRCUIT_STATE.CLOSED);
         expect(res.body.circuits.database.state).toBe(CIRCUIT_STATE.CLOSED);
         expect(res.body.circuits.redis.state).toBe(CIRCUIT_STATE.CLOSED);
      });
   });

   describe('OPEN state fast-fails calls with 503 and Retry-After', () => {
      it('returns 503 dependency_unavailable with Retry-After header when circuit is OPEN', async () => {
         horizonCircuitBreaker.openCircuit();
         expect(horizonCircuitBreaker.isOpen()).toBe(true);

         // Horizon call through horizonRequest should immediately fail fast
         const { horizonGet } = await import('../../clients/horizon.client');

         let caughtError: any;
         try {
            await horizonGet('/ledgers');
         } catch (err) {
            caughtError = err;
         }

         expect(caughtError).toBeDefined();
         expect(caughtError.name).toBe('CircuitBreakerOpenError');
         expect(caughtError.statusCode).toBe(503);
         expect(caughtError.errorCode).toBe('dependency_unavailable');
         expect(caughtError.retryAfter).toBeGreaterThanOrEqual(1);
         expect(caughtError.retryAfter).toBeLessThanOrEqual(30);
      });

      it('Soroban RPC calls fail fast with 503 dependency_unavailable when circuit is OPEN', async () => {
         sorobanRpcCircuitBreaker.openCircuit();
         expect(sorobanRpcCircuitBreaker.isOpen()).toBe(true);

         const { sendTransaction } =
            await import('../../clients/soroban.client');

         let caughtError: any;
         try {
            await sendTransaction('AAAA_XDR_DUMMY');
         } catch (err) {
            caughtError = err;
         }

         expect(caughtError).toBeDefined();
         expect(caughtError.name).toBe('CircuitBreakerOpenError');
         expect(caughtError.statusCode).toBe(503);
         expect(caughtError.errorCode).toBe('dependency_unavailable');
         expect(caughtError.dependency).toBe('soroban_rpc');
      });
   });

   describe('Recovery probes (HALF_OPEN -> CLOSED on success, HALF_OPEN -> OPEN on failure)', () => {
      it('probe success closes the circuit and health endpoint reflects CLOSED', async () => {
         sorobanRpcCircuitBreaker.openCircuit();
         expect(sorobanRpcCircuitBreaker.isOpen()).toBe(true);

         // Configure probe to succeed
         sorobanRpcCircuitBreaker.setProbeFunction(async () => true);

         // Execute probe
         const probeSuccess = await sorobanRpcCircuitBreaker.probe();
         expect(probeSuccess).toBe(true);
         expect(sorobanRpcCircuitBreaker.isClosed()).toBe(true);

         // Health endpoint reflects CLOSED state and records lastProbe timestamp
         const res = await supertest(app)
            .get('/internal/health/circuits')
            .set('x-forwarded-for', '127.0.0.1');

         expect(res.status).toBe(200);
         expect(res.body.status).toBe('ok');
         expect(res.body.circuits.soroban_rpc.state).toBe(CIRCUIT_STATE.CLOSED);
         expect(res.body.circuits.soroban_rpc.failureCount).toBe(0);
         expect(res.body.circuits.soroban_rpc.lastProbe).not.toBeNull();
      });

      it('probe failure re-opens the circuit and resets cooldown', async () => {
         sorobanRpcCircuitBreaker.openCircuit();
         expect(sorobanRpcCircuitBreaker.isOpen()).toBe(true);

         // Configure probe to fail
         sorobanRpcCircuitBreaker.setProbeFunction(async () => {
            throw new Error('Connection refused');
         });

         const probeSuccess = await sorobanRpcCircuitBreaker.probe();
         expect(probeSuccess).toBe(false);
         expect(sorobanRpcCircuitBreaker.isOpen()).toBe(true);

         const res = await supertest(app)
            .get('/internal/health/circuits')
            .set('x-forwarded-for', '127.0.0.1');

         expect(res.status).toBe(200);
         expect(res.body.status).toBe('degraded');
         expect(res.body.circuits.soroban_rpc.state).toBe(CIRCUIT_STATE.OPEN);
         expect(res.body.circuits.soroban_rpc.lastProbe).not.toBeNull();
      });
   });
});
