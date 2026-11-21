// Route tests: PUT /keys/:keyId/circuit-breaker/reset (#1195).
// The reset write is mocked; signature verification is real.

jest.mock('../../utils/prisma.utils', () => ({ prisma: {} }));

jest.mock('./price-velocity-breaker.service', () => {
   const actual = jest.requireActual('./price-velocity-breaker.service');
   return { ...actual, resetPriceVelocityBreaker: jest.fn() };
});

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Keypair } from '@stellar/stellar-base';
import keysRouter from './keys.routes';
import { envConfig } from '../../config';
import {
   BreakerNotTrippedError,
   buildResetCanonicalMessage,
   resetPriceVelocityBreaker,
} from './price-velocity-breaker.service';

const mockReset = resetPriceVelocityBreaker as jest.Mock;
const admin = Keypair.random();
const outsider = Keypair.random();

const app = express();
app.use(express.json());
app.use('/api/v1/keys', keysRouter);

const adminToken = () =>
   jwt.sign({ sub: 'admin-1', role: 'admin' }, envConfig.JWT_SECRET);

function signedHeaders(kp: Keypair, keyId = 'key-1') {
   const timestamp = String(Date.now());
   return {
      Authorization: `Bearer ${adminToken()}`,
      'x-wallet-address': kp.publicKey(),
      'x-wallet-signature': kp
         .sign(buildResetCanonicalMessage(keyId, timestamp))
         .toString('base64'),
      'x-timestamp': timestamp,
   };
}

const originalAdmins = envConfig.ADMIN_MULTISIG_WALLETS;
beforeEach(() => {
   jest.clearAllMocks();
   (envConfig as any).ADMIN_MULTISIG_WALLETS = admin.publicKey();
});
afterAll(() => {
   (envConfig as any).ADMIN_MULTISIG_WALLETS = originalAdmins;
});

describe('PUT /api/v1/keys/:keyId/circuit-breaker/reset', () => {
   it('resets with an admin JWT and a valid admin signature', async () => {
      const result = {
         keyId: 'key-1',
         tradingPaused: false,
         resetTripId: 'trip-1',
         resetAt: '2026-11-21T10:00:00.000Z',
      };
      mockReset.mockResolvedValue(result);

      const res = await request(app)
         .put('/api/v1/keys/key-1/circuit-breaker/reset')
         .set(signedHeaders(admin));

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(result);
      expect(mockReset).toHaveBeenCalledWith(
         expect.anything(),
         'key-1',
         admin.publicKey()
      );
   });

   it('401s without an admin JWT', async () => {
      const headers: Record<string, string> = signedHeaders(admin);
      delete headers.Authorization;
      const res = await request(app)
         .put('/api/v1/keys/key-1/circuit-breaker/reset')
         .set(headers);
      expect(res.status).toBe(401);
      expect(mockReset).not.toHaveBeenCalled();
   });

   it('400s when the signature headers are missing', async () => {
      const res = await request(app)
         .put('/api/v1/keys/key-1/circuit-breaker/reset')
         .set('Authorization', `Bearer ${adminToken()}`);
      expect(res.status).toBe(400);
      expect(mockReset).not.toHaveBeenCalled();
   });

   it('403s a signature from a non-admin wallet', async () => {
      const res = await request(app)
         .put('/api/v1/keys/key-1/circuit-breaker/reset')
         .set(signedHeaders(outsider));
      expect(res.status).toBe(403);
      expect(mockReset).not.toHaveBeenCalled();
   });

   it('403s an admin signature made for another key', async () => {
      const res = await request(app)
         .put('/api/v1/keys/key-1/circuit-breaker/reset')
         .set(signedHeaders(admin, 'key-2'));
      expect(res.status).toBe(403);
      expect(mockReset).not.toHaveBeenCalled();
   });

   it('409s when the breaker is not tripped', async () => {
      mockReset.mockRejectedValue(new BreakerNotTrippedError('key-1'));
      const res = await request(app)
         .put('/api/v1/keys/key-1/circuit-breaker/reset')
         .set(signedHeaders(admin));
      expect(res.status).toBe(409);
   });
});
