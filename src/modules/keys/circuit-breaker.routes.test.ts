// Route tests: GET /keys/:keyId/circuit-breaker (#987).
// The service is mocked; the real query schema is kept so pagination
// validation is exercised.

jest.mock('./circuit-breaker.service', () => ({
   getCircuitBreakerState: jest.fn(),
   KeyNotFoundError: class KeyNotFoundError extends Error {},
}));

import express from 'express';
import request from 'supertest';
import keysRouter from './keys.routes';
import {
   getCircuitBreakerState,
   KeyNotFoundError,
} from './circuit-breaker.service';

const mockGetCircuitBreakerState = getCircuitBreakerState as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/v1/keys', keysRouter);

beforeEach(() => {
   jest.clearAllMocks();
});

describe('GET /api/v1/keys/:keyId/circuit-breaker', () => {
   it('returns the circuit breaker state', async () => {
      const state = {
         keyId: 'key-1',
         maxBps: 2500,
         active: true,
         config: {
            maxBps: 2500,
            source: 'contract',
            cachedAt: '2026-09-28T12:00:00.000Z',
         },
         tripCount: 1,
         limit: 50,
         offset: 0,
         trips: [
            {
               id: 'trip-1',
               actualBps: 2600,
               maxBps: 2500,
               ledger: 12,
               txHash: 'tx-1',
               eventIndex: 0,
               occurredAt: '2026-09-28T11:00:00.000Z',
            },
         ],
      };
      mockGetCircuitBreakerState.mockResolvedValue(state);

      const res = await request(app).get('/api/v1/keys/key-1/circuit-breaker');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(state);
      expect(mockGetCircuitBreakerState).toHaveBeenCalledWith('key-1', {
         limit: 50,
         offset: 0,
      });
   });

   it('defaults to the last 50 trips and passes explicit pagination', async () => {
      mockGetCircuitBreakerState.mockResolvedValue({});

      await request(app).get('/api/v1/keys/key-1/circuit-breaker');
      expect(mockGetCircuitBreakerState).toHaveBeenLastCalledWith('key-1', {
         limit: 50,
         offset: 0,
      });

      await request(app).get(
         '/api/v1/keys/key-1/circuit-breaker?limit=10&offset=20'
      );
      expect(mockGetCircuitBreakerState).toHaveBeenLastCalledWith('key-1', {
         limit: 10,
         offset: 20,
      });
   });

   it('returns 400 for a non-numeric limit', async () => {
      const res = await request(app).get(
         '/api/v1/keys/key-1/circuit-breaker?limit=all'
      );

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(mockGetCircuitBreakerState).not.toHaveBeenCalled();
   });

   it('returns 400 when limit exceeds the maximum', async () => {
      const res = await request(app).get(
         '/api/v1/keys/key-1/circuit-breaker?limit=500'
      );

      expect(res.status).toBe(400);
      expect(mockGetCircuitBreakerState).not.toHaveBeenCalled();
   });

   it('returns 404 for an unknown key', async () => {
      mockGetCircuitBreakerState.mockRejectedValue(
         new KeyNotFoundError('missing')
      );

      const res = await request(app).get(
         '/api/v1/keys/missing/circuit-breaker'
      );

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
   });
});
