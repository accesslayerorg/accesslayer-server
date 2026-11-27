// src/modules/relay/relay.routes.test.ts
// Integration tests for the gasless meta-transaction relay API endpoints (#1088).

const mockCache = new Map<string, any>();

jest.mock('../../utils/redis.utils', () => ({
   cacheGet: jest.fn(async (key: string) =>
      mockCache.has(key) ? JSON.stringify(mockCache.get(key)) : null
   ),
   cacheGetJson: jest.fn(async (key: string) =>
      mockCache.has(key) ? mockCache.get(key) : null
   ),
   cacheSetJson: jest.fn(async (key: string, val: any) => {
      mockCache.set(key, val);
   }),
   cacheInvalidate: jest.fn(async (...keys: string[]) => {
      keys.forEach(key => mockCache.delete(key));
   }),
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

import express from 'express';
import supertest from 'supertest';
import { createRelayRouter } from './relay.routes';
import { resetNonceStateForTests } from '../nonce/nonce.service';

const VALID_WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const INVALID_WALLET = 'not-a-stellar-address';

const mockSigner = {
   verifySignature: jest.fn(async () => true),
};
const mockSubmitter = {
   submitTransaction: jest.fn(async () => ({ txHash: '0xdeadbeef12345678' })),
};

function buildApp() {
   const app = express();
   app.use(express.json());
   app.use('/relay', createRelayRouter(mockSigner, mockSubmitter));
   return app;
}

describe('Relay API Endpoints (#1088)', () => {
   beforeEach(() => {
      mockCache.clear();
      resetNonceStateForTests();
      jest.clearAllMocks();
      mockSigner.verifySignature.mockResolvedValue(true);
      mockSubmitter.submitTransaction.mockResolvedValue({
         txHash: '0xdeadbeef12345678',
      });
   });

   describe('GET /relay/nonce/:wallet', () => {
      it('returns 200 with the next unused nonce for the wallet', async () => {
         const app = buildApp();
         const res = await supertest(app).get(`/relay/nonce/${VALID_WALLET}`);

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data).toMatchObject({
            wallet: VALID_WALLET,
            nonce: 0,
            reserved: true,
         });
         expect(res.body.data.expiresInSeconds).toBeGreaterThan(0);
         expect(res.body.data.expiresInSeconds).toBeLessThanOrEqual(300);
      });

      it('returns the same reserved nonce on repeated calls within the window', async () => {
         const app = buildApp();
         const first = await supertest(app).get(`/relay/nonce/${VALID_WALLET}`);
         const second = await supertest(app).get(
            `/relay/nonce/${VALID_WALLET}`
         );

         expect(second.status).toBe(200);
         expect(second.body.data.nonce).toBe(first.body.data.nonce);
      });

      it('returns 400 when the wallet is not a valid Stellar address', async () => {
         const app = buildApp();
         const res = await supertest(app).get(`/relay/nonce/${INVALID_WALLET}`);

         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
      });
   });

   describe('POST /relay/submit', () => {
      async function reserveNonce(app: express.Application) {
         const res = await supertest(app).get(`/relay/nonce/${VALID_WALLET}`);
         expect(res.status).toBe(200);
         return res.body.data.nonce;
      }

      it('returns 200 and the tx_hash on successful relay', async () => {
         const app = buildApp();
         const nonce = await reserveNonce(app);

         const res = await supertest(app).post('/relay/submit').send({
            wallet: VALID_WALLET,
            nonce,
            signature: 'valid-signature',
            tx_params: 'eyJ0eXBlIjoicHJpY2UifQ==',
         });

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data).toEqual({
            wallet: VALID_WALLET,
            nonce,
            txHash: '0xdeadbeef12345678',
         });
         expect(mockSubmitter.submitTransaction).toHaveBeenCalledWith(
            'eyJ0eXBlIjoicHJpY2UifQ=='
         );
      });

      it('validates the signature before submitting on-chain', async () => {
         const app = buildApp();
         const nonce = await reserveNonce(app);
         mockSigner.verifySignature.mockResolvedValue(false);

         const res = await supertest(app).post('/relay/submit').send({
            wallet: VALID_WALLET,
            nonce,
            signature: 'invalid-signature',
            tx_params: 'eyJ0eXBlIjoicHJpY2UifQ==',
         });

         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
         expect(mockSubmitter.submitTransaction).not.toHaveBeenCalled();
      });

      it('returns 404 when no nonce reservation exists', async () => {
         const app = buildApp();

         const res = await supertest(app).post('/relay/submit').send({
            wallet: VALID_WALLET,
            nonce: 0,
            signature: 'valid-signature',
            tx_params: 'eyJ0eXBlIjoicHJpY2UifQ==',
         });

         expect(res.status).toBe(404);
         expect(res.body.success).toBe(false);
      });

      it('returns 410 when the reservation has expired', async () => {
         const app = buildApp();
         mockCache.set(`relay:nonce:reserved:${VALID_WALLET}`, {
            wallet: VALID_WALLET,
            nonce: 0,
            reservedAt: new Date(0).toISOString(),
            expiresAt: new Date(0).toISOString(),
         });

         const res = await supertest(app).post('/relay/submit').send({
            wallet: VALID_WALLET,
            nonce: 0,
            signature: 'valid-signature',
            tx_params: 'eyJ0eXBlIjoicHJpY2UifQ==',
         });

         expect(res.status).toBe(410);
         expect(res.body.success).toBe(false);
      });

      it('returns 409 when the nonce was already consumed', async () => {
         const app = buildApp();
         mockCache.set(`relay:nonce:reserved:${VALID_WALLET}`, {
            wallet: VALID_WALLET,
            nonce: 0,
            reservedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
         });
         mockCache.set(`relay:nonce:consumed:${VALID_WALLET}:0`, {
            wallet: VALID_WALLET,
            nonce: 0,
            consumedAt: new Date().toISOString(),
         });

         const res = await supertest(app).post('/relay/submit').send({
            wallet: VALID_WALLET,
            nonce: 0,
            signature: 'valid-signature',
            tx_params: 'eyJ0eXBlIjoicHJpY2UifQ==',
         });

         expect(res.status).toBe(409);
         expect(res.body.success).toBe(false);
      });

      it('returns 400 on invalid request body', async () => {
         const app = buildApp();

         const missing = await supertest(app).post('/relay/submit').send({});
         expect(missing.status).toBe(400);

         const badWallet = await supertest(app).post('/relay/submit').send({
            wallet: INVALID_WALLET,
            nonce: 0,
            signature: 'sig',
            tx_params: 'data',
         });
         expect(badWallet.status).toBe(400);
      });
   });

   describe('Rate limiting', () => {
      it('returns 429 when a wallet exceeds 10 relay requests per minute', async () => {
         const app = buildApp();

         for (let i = 0; i < 10; i += 1) {
            const res = await supertest(app).get(
               `/relay/nonce/${VALID_WALLET}`
            );
            expect(res.status).toBe(200);
         }

         const res = await supertest(app).get(`/relay/nonce/${VALID_WALLET}`);
         expect(res.status).toBe(429);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('RATE_LIMIT');
      });

      it('tracks rate limits independently per wallet', async () => {
         const app = buildApp();

         for (let i = 0; i < 10; i += 1) {
            await supertest(app).get(`/relay/nonce/${VALID_WALLET}`);
         }

         // Exhausted wallet is rate limited
         const exhausted = await supertest(app).get(
            `/relay/nonce/${VALID_WALLET}`
         );
         expect(exhausted.status).toBe(429);

         // A different wallet can still make requests
         const other = await supertest(app).get(
            `/relay/nonce/${'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2KM'}`
         );
         expect(other.status).toBe(200);
      });
   });
});
